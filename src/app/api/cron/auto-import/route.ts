import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runAutoImportTick } from "@/lib/auto-import/run";

/**
 * GET /api/cron/auto-import — one tick of the automatic daily catalogue import.
 *
 * Vercel cron every 10 minutes between 07:00 and 20:50 UTC (Bearer CRON_SECRET). Mode and cap come from
 * `settings` (auto_import_mode: off | dry | pilot | live — OFF by default; auto_import_daily_cap, default 100),
 * so switching it on or off needs no deploy. `?force=1` ignores the intra-day pace (manual run, still
 * honours the daily cap, the mode and the lock).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    const data = await trackCron(
      "auto-import",
      () => runAutoImportTick({ force }),
      (r) => {
        if (r.skipped) return `${r.mode}: ${r.skipped}`;
        const live = r.results.filter((x) => x.outcome === "live" || x.outcome === "pilot_draft").length;
        const review = r.results.filter((x) => x.outcome === "needs_review").length;
        const err = r.results.filter((x) => x.outcome === "error").length;
        return `${r.mode}: ${r.results.length} traités (${live} ok, ${review} à revoir, ${err} erreurs) · jour ${r.state.total} importés`;
      },
    );
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[CRON] auto-import failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "auto-import failed" }, { status: 500 });
  }
}
