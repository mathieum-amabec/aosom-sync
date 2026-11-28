/**
 * Resend's free plan sends 100 emails a day. Emails that found no room (engine.ts `capAllows`) wait in
 * `email_outbox` and go out here, from the email-flows cron (every 15 min), most important first:
 * priority 0 (transactional, wheel codes, referral credit) → 1 (cart/checkout) → 2 (reviews) → 3 (marketing).
 * The referral launch (scripts/referral-launch.mts --via resend --per-day N) queues its emails here too, one slice
 * per day (`not_before`), so a launch never eats the whole day's cap.
 *
 * Never twice: each row carries the email's idem key, the same one email_sends and Resend dedupe on.
 */
import type { OutgoingEmail, SendOutcome } from "./engine";

export interface OutboxItem { id: number; idemKey: string; priority: number; notBefore: number; expiresAt: number; payload: string; attempts: number }

export interface DrainDeps {
  now: Date;
  due: (nowSec: number, limit: number) => Promise<OutboxItem[]>;
  finish: (id: number, status: "pending" | "sent" | "skipped" | "failed" | "expired", error?: string | null) => Promise<void>;
  send: (msg: OutgoingEmail) => Promise<SendOutcome>;
  timeLeft: () => boolean;
}

export interface DrainResult { sent: number; skipped: number; failed: number; expired: number; waiting: number; stoppedBy?: string }

export const MAX_ATTEMPTS = 5;

export async function drainOutbox(d: DrainDeps, limit = 100): Promise<DrainResult> {
  const nowSec = Math.floor(d.now.getTime() / 1000);
  const res: DrainResult = { sent: 0, skipped: 0, failed: 0, expired: 0, waiting: 0 };
  const rows = await d.due(nowSec, limit);
  for (const row of rows) {
    if (row.expiresAt < nowSec) { await d.finish(row.id, "expired", "trop tard"); res.expired++; continue; }
    if (!d.timeLeft()) { res.stoppedBy = "time"; break; }
    let msg: OutgoingEmail;
    try {
      msg = { ...(JSON.parse(row.payload) as OutgoingEmail), idemKey: row.idemKey };
    } catch {
      await d.finish(row.id, "failed", "payload illisible");
      res.failed++;
      continue;
    }
    const out = await d.send(msg).catch((err): SendOutcome => ({ status: "failed", error: String(err), retryable: true }));
    if (out.status === "sent" || (out.status === "skipped" && out.reason === "duplicate")) { await d.finish(row.id, "sent"); res.sent++; continue; }
    if (out.status === "skipped") {
      // rows come highest priority first: no room for this one means no room for the ones after it either
      if (out.reason === "daily-cap" || out.reason === "monthly-cap" || out.reason === "off" || out.reason === "not-configured") { res.stoppedBy = out.reason; break; }
      // test mode: a real customer's email waits for the switch to "resend" (or expires)
      if (out.reason === "not-test-recipient") { res.waiting++; continue; }
      await d.finish(row.id, "skipped", out.reason);
      res.skipped++;
      continue;
    }
    if (out.retryable && row.attempts + 1 < MAX_ATTEMPTS) { await d.finish(row.id, "pending", out.error); res.waiting++; continue; }
    await d.finish(row.id, "failed", out.error);
    res.failed++;
  }
  return res;
}

/** Day slices for a bulk send: item i goes out on day floor(i / perDay), at `hourUtc` (14 h UTC = 9 h in Montréal). */
export function spreadOverDays(count: number, perDay: number, start: Date, hourUtc = 14): number[] {
  const day0 = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), hourUtc);
  const first = day0 < start.getTime() ? day0 + 86_400_000 : day0;
  return Array.from({ length: count }, (_, i) => Math.floor((first + Math.floor(i / Math.max(1, perDay)) * 86_400_000) / 1000));
}
