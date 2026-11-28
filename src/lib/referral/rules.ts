/**
 * Programme de parrainage (approved by Mat, variante A, 2026-11-27) — the PURE half: codes, Shopify discount inputs,
 * normalisation and the anti-fraud verdict. Nothing here touches the network or the database.
 *
 * Per customer (created by scripts/referral-launch.mts):
 *   - a personal code `MERCI10-XXXXXX`: 10 $ off a 100 $+ subtotal (before taxes), 1 use, valid 60 days;
 *   - a friend code `AMI-XXXXXX`: the same 10 $ off 100 $+, up to 10 uses, once per customer, valid 90 days.
 * When a friend's PAID order uses the AMI code and passes the anti-fraud rules, the hourly cron
 * (/api/cron/referral-credits) gives the referrer a new `MERCI10-` code (10 $ off 100 $+, 60 days), at most 5 times.
 *
 * Every code is a fixed amount once per order with a minimum subtotal = 10 × the amount, so the margin guard reads it
 * as amount / minimum = 10 % = MAX_DISCOUNT, and it combines with shipping discounts only (never with the 2nd-item
 * promo, BIENVENUE20, the wheel or a MERCI- thank-you code). Shopify store credit was ruled out on purpose: it stacks
 * with everything and the margin guard cannot bound it.
 */
import crypto from "crypto";
import { MAX_DISCOUNT } from "@/lib/sell-price-rule";
import { normalizeEmailKey } from "@/lib/welcome-wheel";

export const REFERRAL_MODE_KEY = "referral_mode";
export type ReferralMode = "off" | "dry" | "live";

/** Default OFF: nothing runs until Mat sets `settings.referral_mode`. */
export function parseReferralMode(raw: string | null | undefined): ReferralMode {
  return raw === "dry" || raw === "live" ? raw : "off";
}

export const PERSONAL_PREFIX = "MERCI10-";
export const FRIEND_PREFIX = "AMI-";

/** Dollars off. */
export const REFERRAL_AMOUNT = 10;
/** Minimum subtotal in dollars (before taxes). 10 / 100 = 10 % = MAX_DISCOUNT. */
export const REFERRAL_MIN_SUBTOTAL = 100;
export const PERSONAL_TTL_DAYS = 60;
export const FRIEND_TTL_DAYS = 90;
export const FRIEND_USAGE_LIMIT = 10;
/** Credits a referrer can earn, ever (a revoked credit frees its slot). */
export const MAX_CREDITS_PER_REFERRER = 5;
/** The cron reads orders created in this window. */
export const LOOKBACK_HOURS = 72;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function randomSuffix(n = 6): string {
  let s = "";
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

export function generatePersonalCode(): string {
  return `${PERSONAL_PREFIX}${randomSuffix()}`;
}

export function generateFriendCode(): string {
  return `${FRIEND_PREFIX}${randomSuffix()}`;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isFriendCode(code: string): boolean {
  return /^AMI-[A-Z0-9]{4,12}$/.test(normalizeCode(code));
}

/** The first AMI- code on an order, normalised, or null. */
export function friendCodeOf(discountCodes: readonly string[]): string | null {
  const c = discountCodes.map(normalizeCode).find(isFriendCode);
  return c ?? null;
}

// ─── Shopify discount inputs ─────────────────────────────────────────────────

export type ReferralCodeKind = "personal" | "friend" | "credit";

export interface ReferralCodeSpec {
  kind: ReferralCodeKind;
  amount: number;
  minSubtotal: number;
  usageLimit: number;
  ttlDays: number;
}

export const CODE_SPECS: Record<ReferralCodeKind, ReferralCodeSpec> = {
  personal: { kind: "personal", amount: REFERRAL_AMOUNT, minSubtotal: REFERRAL_MIN_SUBTOTAL, usageLimit: 1, ttlDays: PERSONAL_TTL_DAYS },
  friend: { kind: "friend", amount: REFERRAL_AMOUNT, minSubtotal: REFERRAL_MIN_SUBTOTAL, usageLimit: FRIEND_USAGE_LIMIT, ttlDays: FRIEND_TTL_DAYS },
  credit: { kind: "credit", amount: REFERRAL_AMOUNT, minSubtotal: REFERRAL_MIN_SUBTOTAL, usageLimit: 1, ttlDays: PERSONAL_TTL_DAYS },
};

/** amount / minimum ≤ MAX_DISCOUNT — the bound the margin guard computes for a fixed amount once per order. */
export function specWithinFloor(s: Pick<ReferralCodeSpec, "amount" | "minSubtotal">): boolean {
  return s.amount > 0 && s.minSubtotal > 0 && s.amount / s.minSubtotal <= MAX_DISCOUNT + 1e-9;
}

const TITLES: Record<ReferralCodeKind, string> = {
  personal: "Parrainage — merci client",
  friend: "Parrainage — code ami",
  credit: "Parrainage — crédit parrain",
};

/** DiscountCodeBasicInput for one referral code. The title starts with the code so a cleanup can find it by prefix. */
export function referralDiscountInput(code: string, kind: ReferralCodeKind, now: Date) {
  const s = CODE_SPECS[kind];
  if (!specWithinFloor(s)) throw new Error(`referral ${kind} code exceeds MAX_DISCOUNT`);
  const expected = kind === "friend" ? FRIEND_PREFIX : PERSONAL_PREFIX;
  if (!code.startsWith(expected)) throw new Error(`referral ${kind} code must start with ${expected}`);
  const ends = new Date(now.getTime() + s.ttlDays * 86_400_000);
  return {
    title: `${code} — ${TITLES[kind]}`,
    code,
    startsAt: now.toISOString(),
    endsAt: ends.toISOString(),
    customerSelection: { all: true },
    customerGets: {
      value: { discountAmount: { amount: s.amount.toFixed(2), appliesOnEachItem: false } },
      items: { all: true },
    },
    minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: s.minSubtotal.toFixed(2) } },
    usageLimit: s.usageLimit,
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
  };
}

// ─── Normalisation (identity matching) ───────────────────────────────────────

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes("@")) return null;
  return normalizeEmailKey(email);
}

/** Digits only, North-American 10 digits (a leading 1 dropped). Null when too short to mean anything. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 7 ? d : null;
}

export interface AddressLike {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
}

function fold(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(rue|street|st|avenue|ave|av|boulevard|boul|blvd|chemin|ch|road|rd|app|apt|appartement|unit|suite|bureau)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Street line + postal code, folded (accents, case, punctuation, street-type words). Two spellings of one address
 * ("123, Rue Saint-Denis app. 4" / "123 st-denis #4") meet when the postal code is the same. Null without both.
 */
export function addressKey(a: AddressLike | null | undefined): string | null {
  if (!a) return null;
  const street = fold(`${a.address1 ?? ""} ${a.address2 ?? ""}`);
  const zip = (a.zip ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!street || !zip) return null;
  return `${street}|${zip}`;
}

/** Stored form (Loi 25: we keep a hash, not the phone or the address itself). */
export function identityHash(value: string): string {
  return crypto.createHash("sha256").update(`parrainage:${value}`).digest("hex").slice(0, 32);
}

// ─── Anti-fraud verdict ──────────────────────────────────────────────────────

export interface ReferralOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelled: boolean;
  test: boolean;
  /** Shopify displayFinancialStatus (PAID, PENDING, AUTHORIZED, PARTIALLY_REFUNDED, REFUNDED, VOIDED, …). */
  financialStatus: string;
  discountCodes: string[];
  email: string | null;
  phone: string | null;
  customerId: string | null;
  shippingAddress: AddressLike | null;
}

export interface Referrer {
  id: number;
  customerId: string | null;
  email: string;
  lang: "fr" | "en";
  friendCode: string;
  credits: number;
  /** identityHash of every phone we know for the referrer. */
  phoneHashes: string[];
  /** identityHash of every address key we know for the referrer. */
  addressHashes: string[];
}

/**
 * credit   → give the referrer a credit;
 * wait     → nothing is decided yet (not paid yet): no row is written, the next run looks again;
 * reject   → final, recorded once (with the reason) so the order is never looked at again.
 */
export type Verdict =
  | { kind: "credit" }
  | { kind: "wait"; reason: "not-paid-yet" }
  | { kind: "reject"; reason: RejectReason };

export type RejectReason =
  | "unknown-code"
  | "test-order"
  | "cancelled"
  | "refunded"
  | "not-first-order"
  | "same-customer"
  | "same-email"
  | "same-phone"
  | "same-address"
  | "max-credits";

/**
 * The anti-fraud rules, in order. `priorOrders` = the friend's orders placed BEFORE this one (same customer or same
 * email), cancelled ones included: anything above 0 means this is not a first order.
 */
export function evaluateReferral(order: ReferralOrder, referrer: Referrer | null, priorOrders: number): Verdict {
  if (!referrer) return { kind: "reject", reason: "unknown-code" };
  if (order.test) return { kind: "reject", reason: "test-order" };
  if (order.cancelled || order.financialStatus === "VOIDED") return { kind: "reject", reason: "cancelled" };
  if (order.financialStatus === "REFUNDED" || order.financialStatus === "PARTIALLY_REFUNDED") return { kind: "reject", reason: "refunded" };
  // PENDING / AUTHORIZED / PARTIALLY_PAID (or any status Shopify adds later): not paid yet — decide on a later run.
  if (order.financialStatus !== "PAID") return { kind: "wait", reason: "not-paid-yet" };
  if (referrer.customerId && order.customerId && referrer.customerId === order.customerId) return { kind: "reject", reason: "same-customer" };
  const fe = normalizeEmail(order.email);
  if (fe && fe === normalizeEmail(referrer.email)) return { kind: "reject", reason: "same-email" };
  const phones = [order.phone, order.shippingAddress?.phone].map(normalizePhone).filter((p): p is string => !!p);
  if (phones.some((p) => referrer.phoneHashes.includes(identityHash(p)))) return { kind: "reject", reason: "same-phone" };
  const ak = addressKey(order.shippingAddress);
  if (ak && referrer.addressHashes.includes(identityHash(ak))) return { kind: "reject", reason: "same-address" };
  if (priorOrders > 0) return { kind: "reject", reason: "not-first-order" };
  if (referrer.credits >= MAX_CREDITS_PER_REFERRER) return { kind: "reject", reason: "max-credits" };
  return { kind: "credit" };
}

/** A friend's order that is now refunded or cancelled: its credit must be withdrawn (when still unused). */
export function shouldRevoke(o: { cancelled: boolean; financialStatus: string }): boolean {
  return o.cancelled || o.financialStatus === "REFUNDED" || o.financialStatus === "PARTIALLY_REFUNDED" || o.financialStatus === "VOIDED";
}

export function langOf(locale: string | null | undefined): "fr" | "en" {
  return (locale ?? "").toLowerCase().startsWith("en") ? "en" : "fr";
}

/** "26 janvier 2027" / "January 26, 2027", Montréal time — for email copy. */
export function formatExpiry(iso: string, lang: "fr" | "en"): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-CA" : "fr-CA", { timeZone: "America/Toronto", day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
}
