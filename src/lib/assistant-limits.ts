/**
 * Conversation limits for the public storefront assistant.
 *
 * Two guards, both ending at the same place — a hand-off to a human:
 *
 *   1. HOURLY QUOTA (enforced, per IP, Turso-backed sliding window). This is the one that
 *      actually bounds cost. It doubles as the "10 messages per session" rule: the session
 *      count the widget could send is client-controlled and trivially reset, so counting
 *      server-side per IP is the only version of that rule with teeth. Both numbers are 10,
 *      so a shopper hits the contact card at the same point either way.
 *
 *   2. RAPID-FIRE (per request, from the submitted history). Three shopper turns in a row
 *      with no assistant turn between them means the shopper is firing messages without
 *      waiting for — or without being helped by — the answers. Escalate to a human instead
 *      of spending three more Claude calls on it.
 *
 * The messages are the shopper-facing copy, so they live here next to the rule that emits
 * them rather than being assembled in the route.
 */
import type { AssistantTurn, Locale } from "./assistant";

/** Accepted messages allowed per IP per rolling hour. Also the session-length cap. */
export const MAX_MESSAGES_PER_HOUR = 10;
export const RATE_WINDOW_SECS = 3600;

/** Consecutive shopper turns (no assistant turn between) before we hand off to a human. */
export const MAX_CONSECUTIVE_USER_TURNS = 3;

export type LimitReason = "hourly_quota" | "consecutive_messages";

/**
 * Store contact details for the hand-off. Env-overridable because they are business data,
 * not code: `ASSISTANT_CONTACT_EMAIL` and `ASSISTANT_CONTACT_WHATSAPP` (digits only, e.g.
 * 15145550123). No WhatsApp number exists anywhere in this repo, so the link is omitted
 * entirely unless the env var is set — an invented number is worse than no button.
 */
export function contactChannels(): { email: string; whatsappUrl: string | null } {
  const email = process.env.ASSISTANT_CONTACT_EMAIL?.trim() || "info@ameublodirect.ca";
  const raw = process.env.ASSISTANT_CONTACT_WHATSAPP?.trim().replace(/[^\d]/g, "") || "";
  return { email, whatsappUrl: raw ? `https://wa.me/${raw}` : null };
}

const MESSAGE: Record<Locale, string> = {
  fr: "Vous avez atteint la limite de questions. Notre équipe peut vous aider directement 😊",
  en: "You've reached the question limit. Our team can help you directly 😊",
};

const CTA: Record<Locale, string> = {
  fr: "Nous écrire",
  en: "Contact us",
};

export interface LimitPayload {
  /** Shape-compatible with AssistantResult — see the note on `reply` below. */
  reply: string;
  products: never[];
  limitReached: true;
  reason: LimitReason;
  message: string;
  contact: { label: string; email: string; emailUrl: string; whatsappUrl: string | null };
  retryAfter: number;
}

const REACH_US: Record<Locale, (channels: string) => string> = {
  fr: (c) => `Écrivez-nous : ${c}`,
  en: (c) => `Reach us at: ${c}`,
};

/**
 * The shopper-facing payload for a tripped limit, localized.
 *
 * `reply` and `products` exist because the DEPLOYED storefront widget (a theme snippet
 * outside this repo) renders exactly `j.data.reply` and `j.data.products` — a payload
 * without them shows the shopper a blank bubble. The widget also inserts the text with
 * `textContent`, so a mailto: URL would render as inert text; the address is therefore
 * spelled out in the sentence itself. The structured `contact` object is there for a
 * future widget revision that can draw a real button.
 */
export function limitPayload(locale: Locale, reason: LimitReason, retryAfterSecs: number): LimitPayload {
  const { email, whatsappUrl } = contactChannels();
  const subject = locale === "en" ? "Help with my order" : "Aide pour ma commande";
  const channels = whatsappUrl ? `${email} · WhatsApp ${whatsappUrl}` : email;
  return {
    reply: `${MESSAGE[locale]} ${REACH_US[locale](channels)}`,
    products: [],
    limitReached: true,
    reason,
    message: MESSAGE[locale],
    contact: {
      label: CTA[locale],
      email,
      emailUrl: `mailto:${email}?subject=${encodeURIComponent(subject)}`,
      whatsappUrl,
    },
    retryAfter: retryAfterSecs,
  };
}

/**
 * How many shopper turns sit at the END of the history with no assistant turn after them.
 * The current (not-yet-appended) message is counted by the caller, so a history ending in
 * two user turns means this request would be the third consecutive one.
 */
export function trailingUserTurns(history: AssistantTurn[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") break;
    n++;
  }
  return n;
}

/** True when accepting this message would exceed the consecutive-shopper-turn allowance. */
export function isRapidFire(history: AssistantTurn[]): boolean {
  return trailingUserTurns(history) + 1 > MAX_CONSECUTIVE_USER_TURNS;
}
