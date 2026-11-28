/**
 * Wheel spins as flow triggers WITHOUT Klaviyo (settings `email_provider` = "resend"): /api/roue then writes the
 * spin, the ticked box and `email_via = 'resend'` to Turso instead of a Klaviyo event, and the engine's three roue
 * emails read them from here. A spin is either a Klaviyo event or a Turso row, never both (email_via); the merge
 * below also drops a Turso row whose code a Klaviyo event already carries, in case.
 */
import type { TriggerEvent } from "../flow-relay";
import { emailKey } from "./unsubscribe";

export interface WheelPrizeLike { key: string; amount: number; minSubtotal: number; labelFr: string; labelEn: string }
export interface SpinRow { id: number; email: string; prize_key: string; code: string | null; expires_at: number | null; locale: string | null; created_at: number }

/** The properties the wheel emails read (same as the Klaviyo "Roue gagnée" event). */
export function wheelEventProps(code: string, prize: WheelPrizeLike, endsAtIso: string, locale: "fr" | "en"): Record<string, unknown> {
  return {
    code,
    prize_fr: prize.labelFr,
    prize_en: prize.labelEn,
    amount: prize.amount,
    min_subtotal: prize.minSubtotal,
    expires_at: endsAtIso,
    locale,
    apply_url_fr: `https://ameublodirect.ca/discount/${code}?redirect=/collections/all`,
    apply_url_en: `https://ameublodirect.ca/discount/${code}?redirect=/en/collections/all`,
  };
}

export function spinToEvent(row: SpinRow, prizes: readonly WheelPrizeLike[]): TriggerEvent | null {
  const prize = prizes.find((p) => p.key === row.prize_key);
  if (!prize || !row.code || !row.expires_at) return null;
  return {
    id: `spin:${row.code}`,
    profileId: `email:${emailKey(row.email)}`,
    email: row.email,
    at: new Date(row.created_at * 1000).toISOString(),
    props: wheelEventProps(row.code, prize, new Date(row.expires_at * 1000).toISOString(), row.locale === "en" ? "en" : "fr"),
  };
}

/** Klaviyo wheel events + Turso spins, without a spin twice. */
export function mergeWheelEvents(klaviyo: TriggerEvent[], rows: SpinRow[], prizes: readonly WheelPrizeLike[]): TriggerEvent[] {
  const codes = new Set(klaviyo.map((e) => String(e.props.code ?? "")).filter(Boolean));
  const fromTurso = rows.filter((r) => r.code && !codes.has(r.code)).map((r) => spinToEvent(r, prizes)).filter((e): e is TriggerEvent => !!e);
  return [...klaviyo, ...fromTurso];
}
