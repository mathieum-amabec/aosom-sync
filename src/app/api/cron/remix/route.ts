import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { REMIX_THEMES, generateAndQueueRemix } from "@/lib/slideshow/remix";

/**
 * GET /api/cron/remix — weekly remix compilation (Module F).
 *
 * Renders ONE themed compilation per week, rotating through REMIX_THEMES by ISO
 * week number, and queues it as a `draft` video in `publication_queue` — same
 * approval gate as every other video (/videos). This cron NEVER schedules or
 * publishes anything by itself; it only produces the next candidate for a human
 * to look at. One theme per run keeps each invocation well under renderRemix's
 * own 8-minute internal timeout and this route's `maxDuration`.
 *
 * Protected by CRON_SECRET (Bearer). Recorded in cron_runs.
 *
 * SCHEDULE — Sundays 09:00 UTC (05:00 America/Montreal), a quiet hour clear of
 * the other crons (see vercel.json).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 540;

/** ISO week number (1-53), used to rotate themes deterministically. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const theme = REMIX_THEMES[isoWeek(new Date()) % REMIX_THEMES.length];
  try {
    const result = await trackCron(
      "remix",
      () => generateAndQueueRemix({ theme }),
      (r) => `theme=${r.theme} clips=${r.clipCount} queueId=${r.queueId} (draft, awaiting approval in /videos)`,
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/remix failed:", err);
    return NextResponse.json({ success: false, error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
