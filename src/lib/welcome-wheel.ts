/**
 * Roue de bienvenue (Mat, 2026-10-19: "je veux le plus de conversions possible").
 *
 * One simple spin wheel replaces the homepage newsletter popup. The SERVER draws the prize (the browser only animates
 * to the slice it is told), so the odds shown on the wheel are the real odds: each slice's size equals its weight.
 * Every slice wins a fixed amount off a minimum subtotal, capped at MAX_DISCOUNT of that minimum, so the margin guard's
 * per-item bound (amount / minimum subtotal) stays within the profit floor. The code is unique, single-use, valid
 * 72 h, and combines with shipping discounts only (never with the 2nd-item promo or BIENVENUE20).
 */
import crypto from "crypto";
import { shopifyFetch } from "./shopify-client";
import { env } from "./config";
import { MAX_DISCOUNT } from "./sell-price-rule";

export interface WheelPrize {
  key: string;
  /** Dollars off the order. */
  amount: number;
  /** Minimum subtotal in dollars. */
  minSubtotal: number;
  /** Relative weight; the wheel slice is drawn at weight / total. */
  weight: number;
  labelFr: string;
  labelEn: string;
}

export const WHEEL_PRIZES: readonly WheelPrize[] = [
  { key: "15-150", amount: 15, minSubtotal: 150, weight: 45, labelFr: "15 $ dès 150 $", labelEn: "$15 off $150+" },
  { key: "25-250", amount: 25, minSubtotal: 250, weight: 30, labelFr: "25 $ dès 250 $", labelEn: "$25 off $250+" },
  { key: "40-400", amount: 40, minSubtotal: 400, weight: 17, labelFr: "40 $ dès 400 $", labelEn: "$40 off $400+" },
  { key: "60-600", amount: 60, minSubtotal: 600, weight: 7, labelFr: "60 $ dès 600 $", labelEn: "$60 off $600+" },
  { key: "100-1000", amount: 100, minSubtotal: 1000, weight: 1, labelFr: "100 $ dès 1 000 $", labelEn: "$100 off $1,000+" },
];

export const CODE_TTL_HOURS = 72;
/** Spins allowed per IP per 24 h (households share an IP; bots get stopped). */
export const SPINS_PER_IP_PER_DAY = 4;

/** Index of the prize for a uniform draw `r` in [0, totalWeight). */
export function prizeIndexFor(r: number, prizes: readonly WheelPrize[] = WHEEL_PRIZES): number {
  let acc = 0;
  for (let i = 0; i < prizes.length; i++) {
    acc += prizes[i].weight;
    if (r < acc) return i;
  }
  return prizes.length - 1;
}

export function drawPrizeIndex(prizes: readonly WheelPrize[] = WHEEL_PRIZES): number {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  return prizeIndexFor(crypto.randomInt(total), prizes);
}

/** Every prize must stay inside the profit floor's MAX_DISCOUNT per item. */
export function prizeWithinFloor(p: WheelPrize): boolean {
  return p.amount > 0 && p.minSubtotal > 0 && p.amount / p.minSubtotal <= MAX_DISCOUNT + 1e-9;
}

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Skill-testing question (Criminal Code s.206: a prize won by chance alone is a lottery). The storefront asks
 * "a + b × c = ?" with small random operands and sends them back with the answer; the server re-checks it.
 * It is a legal requirement, not an anti-bot measure.
 */
export function isSkillAnswerCorrect(skill: unknown): boolean {
  if (!skill || typeof skill !== "object") return false;
  const { a, b, c, answer } = skill as Record<string, unknown>;
  if (![a, b, c].every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 20)) return false;
  const expected = (a as number) + (b as number) * (c as number);
  const given = typeof answer === "string" && answer.trim() !== "" ? Number(answer.trim()) : answer;
  return given === expected;
}

/** Lowercase; for gmail/googlemail also drop dots and +tags, so one person cannot spin twice with aliases. */
export function normalizeEmailKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `ROUE-${s}`;
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(`roue:${ip}`).digest("hex").slice(0, 32);
}

const CREATE_MUTATION = `mutation roueCode($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

export function discountInput(code: string, prize: WheelPrize, now: Date) {
  const ends = new Date(now.getTime() + CODE_TTL_HOURS * 3600_000);
  return {
    title: `Roue de bienvenue — ${prize.labelFr} — ${code}`,
    code,
    startsAt: now.toISOString(),
    endsAt: ends.toISOString(),
    customerSelection: { all: true },
    customerGets: {
      value: { discountAmount: { amount: prize.amount.toFixed(2), appliesOnEachItem: false } },
      items: { all: true },
    },
    minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: prize.minSubtotal.toFixed(2) } },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
  };
}

/** Create the single-use Shopify code. Retries once on a code collision. Throws on any other error. */
export async function createWheelDiscount(prize: WheelPrize, now = new Date()): Promise<{ code: string; discountId: string; endsAt: string }> {
  if (!prizeWithinFloor(prize)) throw new Error(`prize ${prize.key} exceeds MAX_DISCOUNT`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generateCode();
    const input = discountInput(code, prize, now);
    const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query: CREATE_MUTATION, variables: { d: input } }) });
    const j = (await res.json()) as {
      data?: { discountCodeBasicCreate?: { codeDiscountNode: { id: string } | null; userErrors: { field?: string[]; message: string; code?: string }[] } };
      errors?: unknown;
    };
    const out = j.data?.discountCodeBasicCreate;
    if (!res.ok || j.errors || !out) throw new Error(`discountCodeBasicCreate failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
    if (out.codeDiscountNode) return { code, discountId: out.codeDiscountNode.id, endsAt: input.endsAt };
    const taken = out.userErrors.some((e) => e.code === "TAKEN" || /taken|unique/i.test(e.message));
    if (!taken) throw new Error(`discountCodeBasicCreate userErrors: ${JSON.stringify(out.userErrors).slice(0, 300)}`);
  }
  throw new Error("discountCodeBasicCreate: code collision twice");
}

// ─── Klaviyo ─────────────────────────────────────────────────────────────────

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2025-10-15";

async function klaviyo(path: string, body: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  const key = env.klaviyoApiKey;
  if (!key) return { ok: false, error: "Klaviyo not configured" };
  try {
    const res = await fetch(`${KLAVIYO_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: KLAVIYO_REVISION, "Content-Type": "application/vnd.api+json", Accept: "application/vnd.api+json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Email-marketing consent the visitor gave on the wheel form (CASL: express, not pre-checked, purpose stated).
 * Added to the wheel list when one is configured, NOT the newsletter list, so the Welcome Series (BIENVENUE20) does
 * not also fire and offer a second, conflicting code.
 */
export function subscribeBody(email: string, listId: string | null) {
  return {
    data: {
      type: "profile-subscription-bulk-create-job",
      attributes: {
        custom_source: "Roue de bienvenue",
        profiles: {
          data: [{
            type: "profile",
            // Only email + subscriptions: this job rejects other profile fields. The language travels in the event.
            attributes: { email, subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } } },
          }],
        },
      },
      ...(listId ? { relationships: { list: { data: { type: "list", id: listId } } } } : {}),
    },
  };
}

export async function subscribeWheelProfile(email: string, listId: string | null) {
  return klaviyo("/profile-subscription-bulk-create-jobs/", subscribeBody(email, listId));
}

/** Event "Roue gagnée" — triggers the 3-email flow (now, +24 h, +60 h). */
export async function trackWheelWin(email: string, props: Record<string, unknown>) {
  return klaviyo("/events/", {
    data: {
      type: "event",
      attributes: {
        properties: props,
        metric: { data: { type: "metric", attributes: { name: "Roue gagnée" } } },
        profile: { data: { type: "profile", attributes: { email } } },
        unique_id: String(props.code ?? ""),
      },
    },
  });
}
