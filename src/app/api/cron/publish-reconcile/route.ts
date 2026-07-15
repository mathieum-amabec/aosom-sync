import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runPublishReconcile } from "@/lib/publish-reconcile";

/**
 * GET /api/cron/publish-reconcile — publishes to the Online Store the imported products that
 * are sellable in TODAY's Aosom feed but sit unpublished (legacy pre-2026-06-07 drafts never
 * activated, or active-but-never-published). The inverse of stale-catalog.
 *
 * DRY-RUN by default (plans + returns `planned`, writes nothing). Pass `?apply=1` to publish.
 * Excludes `auto-drafted` (intentional aosom-sync drafts) and `exclude-stale` (operator opt-out),
 * publishes only products sellable in the fresh CSV (`stockBufferQty>0` → no oversell), guards on
 * the same `assertFeedComplete` (FEED_MIN_COVERAGE 0.70) as stock-check, and caps writes at 67/run.
 *
 * NOT on any cron schedule (absent from vercel.json) — operator-triggered only. Protected by
 * CRON_SECRET (Bearer). Shopify writes are rate-limited to 2 req/sec.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const apply = new URL(request.url).searchParams.get("apply") === "1";
  try {
    const result = await trackCron(
      apply ? "publish-reconcile" : "publish-reconcile-dryrun",
      () => runPublishReconcile({ apply }),
      (r) =>
        `candidates=${r.candidates} publish=${r.publish} activate+publish=${r.activatePublish}` +
        `${r.deferred ? ` deferred=${r.deferred}` : ""} skipExcludeStale=${r.skippedExcludeStale} skipAutoDrafted=${r.skippedAutoDrafted}` +
        `${r.dryRun ? " [dry-run]" : ` published=${r.published} failed=${r.failed}`}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/publish-reconcile failed:", err);
    return NextResponse.json({ success: false, error: "publish-reconcile failed" }, { status: 500 });
  }
}
