/**
 * Relance paiement #2 avec code — abandoned-checkout reminder #2 carrying a unique 15 $ code.
 *
 * Mat 2026-11-13: "un 15 $ sur le 250 et plus, si les gens n'achètent pas". About 24 h after an
 * unpaid checkout whose merchandise subtotal (before tax) is ≥ 250 $, the shopper gets ONE email
 * with a single-use Shopify code: 15 $ off an order ≥ 250 $, valid 48 h, not combinable with the
 * automatic "10 % sur le 2e article" (margin is 15–20 %), free shipping still applies.
 *
 * It REPLACES the generic reminder #2 (flow-relay.ts step "checkout-2") for those checkouts — never
 * both: while `relance2_enabled` = "1", flow-relay skips checkouts of ≥ 250 $ (`relance2Owns`), and
 * this job skips a checkout whose generic reminder #2 already went out. Same consent basis as the
 * two existing reminders: only after reminder #1 really went out for this checkout (the Klaviyo
 * campaign then skips unsubscribed/suppressed profiles by itself).
 *
 * Sent by the relance-paiement cron (same lease, state row and campaign plumbing). Idempotent: the
 * code is stored per checkout BEFORE the email is sent, and reused on any retry — one checkout never
 * gets two codes nor two emails. Kill switch `relance2_enabled`: OFF unless exactly "1".
 */
import crypto from "crypto";
import { INTERNAL_EMAIL, esc, type CheckoutEvent, type RelanceState } from "./relance-paiement";

export const RELANCE2_ENABLED_KEY = "relance2_enabled";
export const RELANCE2_TEMPLATES_KEY = "relance_paiement2_templates_v1";
export const RELANCE2_MIN_SUBTOTAL = 250;
export const RELANCE2_AMOUNT = 15;
export const RELANCE2_CODE_TTL_H = 48;
/** Send window, in hours after the checkout (target ~24 h). */
export const RELANCE2_MIN_AGE_H = 20;
export const RELANCE2_MAX_AGE_H = 40;
/** At most one code email per profile in this window (several abandoned checkouts ≠ several codes). */
export const RELANCE2_PROFILE_COOLDOWN_H = 30 * 24;

export const relance2Enabled = (raw: string | null) => raw === "1";

/** While reminder #2 with code is ON, the generic reminder #2 (flow-relay "checkout-2") leaves it these checkouts. */
export const relance2Owns = (subtotal: number) => subtotal >= RELANCE2_MIN_SUBTOTAL;

// ─── selection (pure) ──────────────────────────────────────────────────

export type Relance2Skip =
  | "done" | "too-recent" | "too-old" | "no-email" | "internal" | "no-url" | "no-items" | "below-threshold"
  | "no-relance-1" | "ordered" | "checkout-2-sent" | "cooldown" | "busy";

export interface Relance2Ctx {
  now: Date;
  /** Placed an order at/after this ISO time (any order, not only this cart). */
  orderedAfter: (profileId: string, iso: string) => boolean;
  /** The generic reminder #2 (flow-relay "checkout-2") already went out for this checkout. */
  checkout2Sent: (eventId: string) => boolean;
  /** Profiles getting reminder #1 in this same run (their profile properties are being rewritten). */
  busy?: (profileId: string) => boolean;
}

/** No code email less than this after a reminder #1 to the same person (another checkout's). */
export const RELANCE2_GAP_AFTER_R1_H = 12;

export function selectRelance2(events: CheckoutEvent[], state: RelanceState, c: Relance2Ctx): { send: CheckoutEvent[]; skipped: Array<{ eventId: string; reason: Relance2Skip; final: boolean }> } {
  const send: CheckoutEvent[] = [];
  const skipped: Array<{ eventId: string; reason: Relance2Skip; final: boolean }> = [];
  const picked = new Set<string>();
  const now = c.now.getTime();
  for (const e of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
    const age = now - Date.parse(e.at);
    const skip = (reason: Relance2Skip, final: boolean) => skipped.push({ eventId: e.eventId, reason, final });
    if (state.events2?.[e.eventId]) { skip("done", true); continue; }
    if (age < RELANCE2_MIN_AGE_H * 3600e3) { skip("too-recent", false); continue; }
    if (age > RELANCE2_MAX_AGE_H * 3600e3) { skip("too-old", true); continue; }
    if (!e.email) { skip("no-email", true); continue; }
    if (INTERNAL_EMAIL.test(e.email)) { skip("internal", true); continue; }
    if (!e.recoverUrl) { skip("no-url", true); continue; }
    if (!e.items.length) { skip("no-items", true); continue; }
    if (!relance2Owns(e.subtotal)) { skip("below-threshold", true); continue; }
    // consent basis of the existing reminders: #2 only after #1 really went out (a #1 retry may still land → not final)
    if (!state.sent?.[e.eventId]) { skip("no-relance-1", false); continue; }
    if (c.orderedAfter(e.profileId, e.at)) { skip("ordered", true); continue; }
    if (c.checkout2Sent(e.eventId)) { skip("checkout-2-sent", true); continue; }
    const lastR1 = state.profiles?.[e.profileId];
    if (c.busy?.(e.profileId) || (lastR1 && now - Date.parse(lastR1) < RELANCE2_GAP_AFTER_R1_H * 3600e3)) { skip("busy", false); continue; }
    const last = state.profiles2?.[e.profileId];
    if (picked.has(e.profileId) || (last && now - Date.parse(last) < RELANCE2_PROFILE_COOLDOWN_H * 3600e3)) { skip("cooldown", true); continue; }
    picked.add(e.profileId);
    send.push(e);
  }
  return { send, skipped };
}

// ─── Shopify code ──────────────────────────────────────────────────────

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const CODE_PREFIX = "RELANCE15-";

/** `RELANCE15-` + 10 random chars (32-letter alphabet → 50 bits): unguessable. */
export function generateRelance2Code(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return CODE_PREFIX + s;
}

export const DISCOUNT_MUTATION = `mutation relance2Code($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

/** discountCodeBasicCreate input: 15 $ off the order, min. 250 $ subtotal, 1 use, 48 h, free shipping still stacks. */
export function relance2DiscountInput(code: string, now: Date) {
  return {
    title: code,
    code,
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + RELANCE2_CODE_TTL_H * 3600e3).toISOString(),
    customerSelection: { all: true },
    customerGets: {
      value: { discountAmount: { amount: RELANCE2_AMOUNT.toFixed(2), appliesOnEachItem: false } },
      items: { all: true },
    },
    minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: RELANCE2_MIN_SUBTOTAL.toFixed(2) } },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    // the automatic BXGY "10 % sur le 2e article" must NOT stack with it
    combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true },
  };
}
export type Relance2DiscountInput = ReturnType<typeof relance2DiscountInput>;

type GqlFetch = (endpoint: string, init: RequestInit) => Promise<Response>;

/** Create the code in Shopify. Returns null on a code collision (caller retries with a new code); throws on anything else. */
export async function createRelance2Discount(input: Relance2DiscountInput, gql?: GqlFetch): Promise<{ discountId: string } | null> {
  const f = gql ?? (await import("./shopify-client")).shopifyFetch;
  const res = await f("/graphql.json", { method: "POST", body: JSON.stringify({ query: DISCOUNT_MUTATION, variables: { d: input } }) });
  const j = (await res.json()) as {
    data?: { discountCodeBasicCreate?: { codeDiscountNode: { id: string } | null; userErrors: Array<{ field?: string[]; message: string; code?: string }> } };
    errors?: unknown;
  };
  const out = j.data?.discountCodeBasicCreate;
  if (!res.ok || j.errors || !out) throw new Error(`discountCodeBasicCreate failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  if (out.codeDiscountNode) return { discountId: out.codeDiscountNode.id };
  if (out.userErrors.some((e) => e.code === "TAKEN" || /taken|unique/i.test(e.message))) return null;
  throw new Error(`discountCodeBasicCreate userErrors: ${JSON.stringify(out.userErrors).slice(0, 300)}`);
}

export interface EnsureCodesDeps {
  now: Date;
  state: RelanceState;
  /** Persist the state (called right after each code is created, before any email). */
  save: (s: RelanceState) => Promise<void>;
  create: (input: Relance2DiscountInput) => Promise<{ discountId: string } | null>;
  genCode?: () => string;
}

export type StoredCode = RelanceState["codes"][string];

/**
 * One code per checkout: reuse the stored one, else create it and save the state at once.
 * Dry run: creates nothing, saves nothing, returns the payloads it would send.
 */
export async function ensureRelance2Codes(cands: CheckoutEvent[], d: EnsureCodesDeps, opts: { dryRun?: boolean } = {}): Promise<{
  ready: Array<{ event: CheckoutEvent; code: StoredCode }>;
  wouldCreate: Relance2DiscountInput[];
  errors: Array<{ eventId: string; error: string }>;
}> {
  const ready: Array<{ event: CheckoutEvent; code: StoredCode }> = [];
  const wouldCreate: Relance2DiscountInput[] = [];
  const errors: Array<{ eventId: string; error: string }> = [];
  const gen = d.genCode ?? generateRelance2Code;
  d.state.codes = d.state.codes ?? {};
  for (const e of cands) {
    const have = d.state.codes[e.eventId];
    // a stored code is reused while it still has ≥ 12 h left (retry runs are minutes/hours apart)
    if (have && Date.parse(have.endsAt) - d.now.getTime() >= 12 * 3600e3) { ready.push({ event: e, code: have }); continue; }
    if (have) { errors.push({ eventId: e.eventId, error: "code-expiring" }); continue; }
    if (opts.dryRun) { wouldCreate.push(relance2DiscountInput(`${CODE_PREFIX}DRYRUN`, d.now)); continue; }
    try {
      let made: StoredCode | null = null;
      for (let attempt = 0; attempt < 2 && !made; attempt++) {
        const input = relance2DiscountInput(gen(), d.now);
        const r = await d.create(input);
        if (r) made = { code: input.code, discountId: r.discountId, endsAt: input.endsAt, at: d.now.toISOString() };
      }
      if (!made) throw new Error("discountCodeBasicCreate: code collision twice");
      d.state.codes[e.eventId] = made;
      await d.save(d.state);
      ready.push({ event: e, code: made });
    } catch (err) {
      errors.push({ eventId: e.eventId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ready, wouldCreate, errors };
}

// ─── email ─────────────────────────────────────────────────────────────

/** "15 novembre à 14 h 05" / "November 15 at 2:05 p.m." — Eastern time (Quebec). */
export function formatExpiry(iso: string, locale: "fr" | "en"): string {
  return new Intl.DateTimeFormat(locale === "fr" ? "fr-CA" : "en-CA", {
    timeZone: "America/Toronto", day: "numeric", month: "long", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

const COPY2 = {
  fr: {
    brand: "Ameublo Direct",
    subject: "15 $ de rabais pour terminer ta commande",
    preview: "Ton code est valide 48 h sur les commandes de 250 $ et plus.",
    title: "Un petit 15 $ pour t'aider à te décider",
    intro: "Ton panier chez Ameublo Direct est encore là. Si le prix te faisait hésiter, voici un code de 15 $ de rabais, rien que pour toi :",
    terms: "15 $ de rabais sur une commande de 250 $ et plus (avant taxes). Valide 48 h, jusqu'au",
    tz: "(heure de l'Est)",
    once: "Une seule utilisation, non combinable avec d'autres rabais.",
    howto: "Reprends ta commande avec le bouton ci-dessous, puis entre le code dans la case « Code de réduction » à la caisse.",
    cta: "Reprendre ma commande",
    perks: "✔ Livraison gratuite partout au Canada",
    help: "Une question avant de commander? Réponds simplement à ce courriel.",
    unsubscribe: "Se désabonner",
  },
  en: {
    brand: "Furnish Direct",
    subject: "$15 off to finish your order",
    preview: "Your code is valid for 48 h on orders of $250 or more.",
    title: "A little $15 to help you decide",
    intro: "Your cart at Furnish Direct is still waiting. If the price was holding you back, here's a $15 off code, just for you:",
    terms: "$15 off an order of $250 or more (before tax). Valid for 48 h, until",
    tz: "(Eastern time)",
    once: "Single use, can't be combined with other discounts.",
    howto: "Pick up your order with the button below, then enter the code in the “Discount code” field at checkout.",
    cta: "Complete my order",
    perks: "✔ Free shipping anywhere in Canada",
    help: "A question before ordering? Just reply to this email.",
    unsubscribe: "Unsubscribe",
  },
} as const;

export function relance2Subject(locale: "fr" | "en"): { subject: string; preview: string } {
  return { subject: COPY2[locale].subject, preview: COPY2[locale].preview };
}

/** Per-person profile properties the template reads. */
export function relance2ProfileProps(e: CheckoutEvent, code: StoredCode, itemsHtml: string): Record<string, string> {
  return {
    relance_url: e.recoverUrl ?? "",
    relance_items_html: itemsHtml,
    relance_checkout_at: e.at,
    relance2_code: code.code,
    relance2_expires: formatExpiry(code.endsAt, e.locale),
  };
}

/** Klaviyo CODE template: code, expiry, items and recover link come from profile properties. */
export function buildRelance2TemplateHtml(locale: "fr" | "en"): string {
  const c = COPY2[locale];
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f1ec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px">
<tr><td style="padding:24px 24px 8px;font:bold 20px Arial,sans-serif;color:#222">${c.brand}</td></tr>
<tr><td style="padding:8px 24px;font:bold 22px/1.3 Arial,sans-serif;color:#222">${esc(c.title)}</td></tr>
<tr><td style="padding:0 24px 8px;font:15px/1.5 Arial,sans-serif;color:#444">${esc(c.intro)}</td></tr>
<tr><td align="center" style="padding:12px 24px"><div style="display:inline-block;border:2px dashed #c8553d;border-radius:8px;padding:14px 22px;font:bold 22px/1 'Courier New',monospace;letter-spacing:2px;color:#222">{{ person|lookup:'relance2_code' }}</div></td></tr>
<tr><td style="padding:0 24px 8px;font:14px/1.5 Arial,sans-serif;color:#444;text-align:center">${esc(c.terms)} {{ person|lookup:'relance2_expires' }} ${esc(c.tz)}.<br>${esc(c.once)}</td></tr>
<tr><td style="padding:0 24px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">{{ person|lookup:'relance_items_html'|safe }}</table></td></tr>
<tr><td style="padding:12px 24px 0;font:14px/1.5 Arial,sans-serif;color:#444">${esc(c.howto)}</td></tr>
<tr><td align="center" style="padding:20px 24px"><a href="{{ person|lookup:'relance_url' }}" style="display:inline-block;background:#c8553d;color:#ffffff;text-decoration:none;font:bold 16px Arial,sans-serif;padding:14px 28px;border-radius:6px">${esc(c.cta)}</a></td></tr>
<tr><td style="padding:0 24px 16px;font:14px/1.6 Arial,sans-serif;color:#444">${c.perks}</td></tr>
<tr><td style="padding:0 24px 24px;font:14px/1.5 Arial,sans-serif;color:#666">${esc(c.help)}</td></tr>
</table>
<p style="font:12px/1.5 Arial,sans-serif;color:#888;max-width:560px">{{ organization.name }} · {{ organization.full_address }}<br>{% unsubscribe '${c.unsubscribe}' %}</p>
</td></tr></table></body></html>`;
}
