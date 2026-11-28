/**
 * Room under Klaviyo's free plan (250 ACTIVE profiles; above it Klaviyo blocks every send) until the switch to
 * Resend: which active profiles can be SUPPRESSED (reversible, a suppressed profile no longer counts) without
 * losing anyone who matters. Used by scripts/klaviyo-headroom.mts. Pure, so the rules are tested.
 *
 * Kept (never suppressed): buyers (Klaviyo "Placed Order" or a Shopify customer with an order), subscribers
 * (Klaviyo or Shopify consent SUBSCRIBED), profiles created in the last 14 days, profiles with a reminder that may
 * still go out (cart / checkout / wheel event in the last 7 days — the relays' longest window is 72 h), internal
 * addresses, and phone-only profiles (an email suppression cannot target them).
 */

export interface HeadroomProfile {
  id: string;
  email: string | null;
  created: string | null;
  /** Klaviyo subscriptions.email.marketing */
  consent: string | null;
  suppressed: boolean;
  /** Klaviyo suppression timestamps (ISO), when suppressed */
  suppressedAt: string[];
}

export interface HeadroomContext {
  now: Date;
  /** Klaviyo profile ids with a Placed Order. */
  buyerIds: ReadonlySet<string>;
  /** Lower-case emails of Shopify customers with at least one order. */
  shopifyBuyerEmails: ReadonlySet<string>;
  /** Lower-case emails of Shopify customers whose email marketing consent is SUBSCRIBED. */
  shopifySubscriberEmails: ReadonlySet<string>;
  /** Klaviyo profile ids with a cart / checkout / wheel event in the last 7 days. */
  ongoingIds: ReadonlySet<string>;
  /** Lower-case addresses never to touch (Mat's own…). */
  protectedEmails: ReadonlySet<string>;
}

export type HeadroomVerdict =
  | "deja-bloque" | "acheteur" | "abonne" | "recent" | "relance-en-cours" | "interne" | "sans-courriel" | "a-bloquer";

export const RECENT_DAYS = 14;
const INTERNAL = /@ameublodirect\.ca$|@furnishdirect\.ca$/i;

export function classifyProfile(p: HeadroomProfile, c: HeadroomContext): HeadroomVerdict {
  if (p.suppressed) return "deja-bloque";
  const email = (p.email ?? "").trim().toLowerCase();
  if (!email) return "sans-courriel";
  if (INTERNAL.test(email) || c.protectedEmails.has(email)) return "interne";
  if (c.buyerIds.has(p.id) || c.shopifyBuyerEmails.has(email)) return "acheteur";
  if ((p.consent ?? "").toUpperCase() === "SUBSCRIBED" || c.shopifySubscriberEmails.has(email)) return "abonne";
  const created = Date.parse(p.created ?? "");
  // unknown creation date: kept (the safe side is to keep one profile too many)
  if (!Number.isFinite(created) || c.now.getTime() - created < RECENT_DAYS * 86_400_000) return "recent";
  if (c.ongoingIds.has(p.id)) return "relance-en-cours";
  return "a-bloquer";
}

export interface HeadroomReport {
  total: number;
  active: number;
  byVerdict: Record<HeadroomVerdict, number>;
  candidates: Array<{ id: string; email: string }>;
  activeAfter: number;
  /** Shopify subscribers whose Klaviyo profile is suppressed (counts only, no personal data). */
  shopifySubscribersBlocked: { total: number; on20261113: number };
}

export function buildReport(profiles: HeadroomProfile[], c: HeadroomContext): HeadroomReport {
  const byVerdict = { "deja-bloque": 0, acheteur: 0, abonne: 0, recent: 0, "relance-en-cours": 0, interne: 0, "sans-courriel": 0, "a-bloquer": 0 } as Record<HeadroomVerdict, number>;
  const candidates: Array<{ id: string; email: string }> = [];
  let blockedSubs = 0, blockedSubs1113 = 0;
  for (const p of profiles) {
    const v = classifyProfile(p, c);
    byVerdict[v]++;
    if (v === "a-bloquer") candidates.push({ id: p.id, email: (p.email as string).trim() });
    const email = (p.email ?? "").trim().toLowerCase();
    if (p.suppressed && email && c.shopifySubscriberEmails.has(email)) {
      blockedSubs++;
      if (p.suppressedAt.some((t) => t.startsWith("2026-11-13"))) blockedSubs1113++;
    }
  }
  const active = profiles.length - byVerdict["deja-bloque"];
  return { total: profiles.length, active, byVerdict, candidates, activeAfter: active - candidates.length, shopifySubscribersBlocked: { total: blockedSubs, on20261113: blockedSubs1113 } };
}

/** Body of Klaviyo's bulk suppression job (≤ 100 emails per job). Reversible with the bulk-delete job. */
export function suppressionJob(emails: string[], undo = false) {
  const type = undo ? "profile-suppression-bulk-delete-job" : "profile-suppression-bulk-create-job";
  return { data: { type, attributes: { profiles: { data: emails.map((email) => ({ type: "profile", attributes: { email } })) } } } };
}
