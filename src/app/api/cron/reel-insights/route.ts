import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { listReelsToMeasure, saveReelInsight } from "@/lib/database";
import { fetchFacebookReelInsights } from "@/lib/reel-insights-client";

/**
 * GET /api/cron/reel-insights — Vercel cron, Bearer CRON_SECRET required. READ-ONLY toward Facebook.
 *
 * Once a day, reads the insights (plays, watch time, social actions) of every Reel published in the last 14 days whose Facebook
 * id we recorded at publish time, and stores one snapshot per Reel per day. Runs BEFORE the 06:00 Montreal morning report so the
 * report's "Résultats des Reels" section reads this morning's numbers. One failing Reel (deleted, token hiccup) is counted and
 * skipped — it never stops the others; the run is recorded in `cron_runs` either way.
 *
 * A time budget keeps the run well under maxDuration: newest Reels first (their numbers move the most), so a slow Graph API only
 * ever costs the oldest ones.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WINDOW_DAYS = 14;
const BUDGET_MS = 90_000;
const PACE_MS = 200;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "reel-insights",
      async () => {
        const reels = await listReelsToMeasure(WINDOW_DAYS);
        const started = Date.now();
        let measured = 0;
        let failed = 0;
        let skipped = 0;
        let firstError: string | undefined;
        for (const r of reels) {
          if (Date.now() - started > BUDGET_MS) {
            skipped++;
            continue;
          }
          try {
            await saveReelInsight(r.queueId, "facebook", r.fbPostId, await fetchFacebookReelInsights(r.fbPostId, r.brand));
            measured++;
          } catch (err) {
            failed++;
            firstError ??= err instanceof Error ? err.message : String(err);
          }
          await new Promise((res) => setTimeout(res, PACE_MS));
        }
        return { total: reels.length, measured, failed, skipped, firstError };
      },
      (r) => `${r.measured}/${r.total} Reels measured${r.failed ? `, ${r.failed} failed (${r.firstError})` : ""}${r.skipped ? `, ${r.skipped} skipped (time budget)` : ""}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[CRON] reel-insights failed:", err);
    return NextResponse.json({ success: false, error: "reel-insights failed" }, { status: 500 });
  }
}
