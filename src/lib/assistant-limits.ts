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

/**
 * Accepted messages allowed per IP per rolling hour, counted in Turso so the number is
 * shared across Vercel instances rather than reset by every cold start.
 *
 * Raised from 10 to 20 on 2026-08-28 at the operator's instruction. Worth stating plainly:
 * this LOOSENS the per-IP ceiling — it doubles what one address can spend in an hour. The
 * quota was already Turso-backed and already enforced; the security gain in this release is
 * the token gate and the graceful budget path, not this number.
 *
 * It no longer doubles as the session-length cap (both used to be 10). The rapid-fire guard
 * below is what bounds a single runaway conversation now.
 */
export const MAX_MESSAGES_PER_HOUR = 20;
export const RATE_WINDOW_SECS = 3600;

/** Consecutive shopper turns (no assistant turn between) before we hand off to a human. */
export const MAX_CONSECUTIVE_USER_TURNS = 3;

export type LimitReason = "hourly_quota" | "consecutive_messages" | "budget_exhausted" | "daily_quota" | "blocked";

/**
 * Store contact details for the hand-off. Env-overridable because they are business data,
 * not code: `ASSISTANT_CONTACT_EMAIL` and `ASSISTANT_CONTACT_WHATSAPP` (digits only, e.g.
 * 15145550123). No WhatsApp number exists anywhere in this repo, so the link is omitted
 * entirely unless the env var is set — an invented number is worse than no button.
 */
/** Store phone for the hand-offs (the one in the site header). Env-overridable. */
export function contactPhone(): string {
  return process.env.ASSISTANT_CONTACT_PHONE?.trim() || "514-292-7788";
}

export function contactChannels(): { email: string; whatsappUrl: string | null } {
  const email = process.env.ASSISTANT_CONTACT_EMAIL?.trim() || "info@ameublodirect.ca";
  const raw = process.env.ASSISTANT_CONTACT_WHATSAPP?.trim().replace(/[^\d]/g, "") || "";
  return { email, whatsappUrl: raw ? `https://wa.me/${raw}` : null };
}

/**
 * Shopper-facing copy per reason. Localized here, next to the rules that emit them.
 *
 * `hourly_quota` takes the minutes left so the shopper is told when to come back rather
 * than being stonewalled; the other two are terminal for this visit and go straight to the
 * hand-off. Every one of them still ends with a way to reach a human — a dead end with no
 * next step is the one outcome worse than the limit itself.
 */
function minutesLabel(locale: Locale, mins: number): string {
  if (locale === "en") return mins <= 1 ? "in about a minute" : `in about ${mins} minutes`;
  return mins <= 1 ? "dans une minute environ" : `dans environ ${mins} minutes`;
}

/**
 * Reasons whose copy already NAMES the contact address, so `limitPayload` must not append
 * the generic "Écrivez-nous : …" tail on top of it. A set rather than an inline check in
 * two places, so adding another self-contained reason can't half-apply.
 */
const SELF_CONTAINED_REASONS: ReadonlySet<LimitReason> = new Set<LimitReason>(["budget_exhausted"]);

function messageFor(
  locale: Locale,
  reason: LimitReason,
  retryAfterSecs: number,
  email: string,
): string {
  const mins = Math.max(1, Math.ceil(retryAfterSecs / 60));
  // In Ameublo's voice since 2026-10-02 (Mat: lighter, a bit funny, still professional, in
  // character — the mascot is a little armchair). Every one still ends with a human contact.
  if (reason === "hourly_quota") {
    return locale === "en"
      ? `Phew, that was a lot of questions in a row! Let me fluff my cushions and come back ${minutesLabel(locale, mins)} 🛋️`
      : `Ouf, ça fait beaucoup de questions d'affilée ! Laissez-moi regonfler mes coussins et revenez me voir ${minutesLabel(locale, mins)} 🛋️`;
  }
  if (reason === "daily_quota") {
    // Per-visitor daily token cap (assistant-guard.ts). Resets at 00:00 UTC.
    return locale === "en"
      ? "We've looked at a lot of furniture together today! I need a little rest until tomorrow, but our team is happy to take over 😊"
      : "On a fait le tour de bien des meubles ensemble aujourd'hui ! J'ai besoin d'un petit repos jusqu'à demain, mais notre équipe prend le relais avec plaisir 😊";
  }
  if (reason === "blocked") {
    // Automatic abuse block (assistant-guard.ts). Neutral wording on purpose: a false positive
    // must not read as an accusation, and it still offers a human.
    return locale === "en"
      ? "I can't continue the conversation from your connection for now. Our team can help you directly."
      : "Je ne peux pas poursuivre la conversation depuis votre connexion pour le moment. Notre équipe peut vous aider directement.";
  }
  if (reason === "budget_exhausted") {
    // Self-contained: it names the contacts itself, so no bolted-on tail.
    return locale === "en"
      ? `I'm taking a little nap in my corner 💤 Email us at ${email} or call ${contactPhone()}, we'll gladly help!`
      : `Je fais une petite sieste dans mon coin 💤 Écrivez-nous à ${email} ou appelez le ${contactPhone()}, on vous répond avec plaisir !`;
  }
  // consecutive_messages: several messages fired without waiting for the answers.
  return locale === "en"
    ? "One question at a time and I'll keep up, promise 😄 If it's easier, our team can answer you directly."
    : "Une question à la fois et je vous suis, promis 😄 Si c'est plus simple, notre équipe peut vous répondre directement.";
}

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
  fr: (c) => `Écrivez-nous : ${c} · ou appelez le ${contactPhone()}`,
  en: (c) => `Reach us at: ${c} · or call ${contactPhone()}`,
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
  const message = messageFor(locale, reason, retryAfterSecs, email);
  return {
    // Self-contained copy already names the email, so it skips the REACH_US tail — but it must
    // NOT silently drop WhatsApp when one is configured, or the most common limit path would be
    // the only one that doesn't offer it. `message` stays verbatim; only `reply` gains the extra
    // channel.
    reply: SELF_CONTAINED_REASONS.has(reason)
      ? (whatsappUrl ? `${message} · WhatsApp ${whatsappUrl}` : message)
      : `${message} ${REACH_US[locale](channels)}`,
    products: [],
    limitReached: true,
    reason,
    message,
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
