/**
 * Marketing consent, read from Klaviyo (it holds the checkout checkbox, the newsletter and wheel
 * opt-ins, and the unsubscribes made from relay emails), and kept in sync both ways during the
 * hand-over: an unsubscribe from one of OUR emails is also pushed to Klaviyo, so the relays stop too.
 */
import { kv } from "../klaviyo-campaigns";
import type { ConsentBasis } from "./flows";

export interface KlaviyoConsent {
  /** SUBSCRIBED | UNSUBSCRIBED | NEVER_SUBSCRIBED | … (Klaviyo's value, upper-case) */
  consent: string;
  /** Klaviyo suppression (unsubscribed, bounced, spam complaint…). */
  suppressed: boolean;
}

type ProfileJson = { data?: { attributes?: { subscriptions?: { email?: { marketing?: { consent?: string; can_receive_email_marketing?: boolean; suppression?: unknown[] } } } } } };

export function parseKlaviyoConsent(j: ProfileJson): KlaviyoConsent {
  const m = j.data?.attributes?.subscriptions?.email?.marketing;
  return {
    consent: String(m?.consent ?? "UNKNOWN").toUpperCase(),
    suppressed: (Array.isArray(m?.suppression) && m!.suppression!.length > 0),
  };
}

/** May this person get a marketing email under this consent basis? Unsubscribed or suppressed = never. */
export function mayEmail(c: KlaviyoConsent, basis: ConsentBasis): boolean {
  if (c.suppressed || c.consent === "UNSUBSCRIBED") return false;
  return basis === "own" || c.consent === "SUBSCRIBED";
}

export async function klaviyoConsent(profileId: string): Promise<KlaviyoConsent> {
  if (!/^[A-Za-z0-9]+$/.test(profileId)) throw new Error("bad profile id");
  return parseKlaviyoConsent(await kv<ProfileJson>("GET", `/profiles/${profileId}/?additional-fields[profile]=subscriptions&fields[profile]=subscriptions`));
}

/** Best effort: suppress the address in Klaviyo so relay emails stop too. */
export async function suppressInKlaviyo(email: string): Promise<void> {
  await kv("POST", "/profile-suppression-bulk-create-jobs/", {
    data: { type: "profile-suppression-bulk-create-job", attributes: { profiles: { data: [{ type: "profile", attributes: { email } }] } } },
  });
}
