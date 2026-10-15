import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runCompareAtSync } from "@/lib/compare-at";
import { defaultCompareAtDeps } from "@/lib/compare-at-db";

/**
 * GET /api/cron/compare-at-sync — daily. Sets the struck-through "Ancien prix" on every variant whose price is 10 %
 * or more below a price it held for 14+ days in the last 90 (see compare-at.ts), and clears invalid ones.
 *
 * Controlled by `settings.compare_at_mode` = off | dry | live (default off): `dry` stores the plan in
 * `compare_at_last_plan` and writes nothing to Shopify. Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "compare-at-sync",
      () => runCompareAtSync({ deps: defaultCompareAtDeps() }),
      (r) =>
        `${r.mode}${r.skipped ? ` (${r.skipped})` : ""}: seen=${r.variantsSeen} set=${r.plan.changes.filter((c) => c.action === "set").length} clear=${r.plan.changes.filter((c) => c.action === "clear").length} applied=${r.applied} failed=${r.failed} deferred=${r.deferred} kept=${r.plan.keptValid} drift=${r.plan.skippedDrift}`,
    );
    return NextResponse.json({
      success: true,
      data: { mode: result.mode, skipped: result.skipped ?? null, variantsSeen: result.variantsSeen, applied: result.applied, failed: result.failed, deferred: result.deferred, planned: result.plan.changes.length },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "compare-at sync failed" }, { status: 500 });
  }
}
