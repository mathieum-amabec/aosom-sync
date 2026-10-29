import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runCostwayReprice } from "@/lib/costway/reprice";
import { defaultCostwayRepriceDeps } from "@/lib/costway/reprice-db";

/**
 * GET /api/cron/costway-reprice — daily, after costway-sync. Puts every Costway variant on Shopify at Costway's price
 * and shows the crossed price on a drop of 10 % or more (see costway/reprice.ts).
 *
 * Controlled by `settings.costway_reprice_mode` = off | dry | live (default off); the crossed-price step follows
 * `compare_at_mode`. Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const r = await trackCron(
      "costway-reprice",
      () => runCostwayReprice({ deps: defaultCostwayRepriceDeps() }),
      (r) =>
        `${r.mode}${r.skipped ? ` (${r.skipped})` : ""}: changes=${r.plan.changes.length} applied=${r.applied} failed=${r.failed} deferred=${r.deferred} same=${r.plan.same} missing=${r.plan.missing} suspicious=${r.plan.suspicious.length}` +
        (r.compareAt ? ` · ancien prix ${r.compareAt.mode}: applied=${r.compareAt.applied} failed=${r.compareAt.failed} kept=${r.compareAt.plan.keptValid}` : ""),
    );
    return NextResponse.json({
      success: true,
      data: {
        mode: r.mode, skipped: r.skipped ?? null, planned: r.plan.changes.length, applied: r.applied, failed: r.failed, deferred: r.deferred,
        same: r.plan.same, missing: r.plan.missing, suspicious: r.plan.suspicious,
        compareAt: r.compareAt ? { mode: r.compareAt.mode, skipped: r.compareAt.skipped ?? null, applied: r.compareAt.applied, failed: r.compareAt.failed, planned: r.compareAt.plan.changes.length } : null,
      },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "costway reprice failed" }, { status: 500 });
  }
}
