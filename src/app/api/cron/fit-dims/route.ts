import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { syncFitDims } from "@/lib/fit-dims-sync";

/**
 * GET /api/cron/fit-dims — daily safety net for the PDP fit checker: writes the `custom.lc_dims` metafield on every
 * product whose Aosom sizes are missing or changed (new imports already get it at creation). Scheduled daily at
 * 21:15 UTC, after the day's automatic imports (7–20 UTC). Applies by default; `?dry=1` only plans.
 * Protected by CRON_SECRET (Bearer). See src/lib/fit-dims-sync.ts.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const apply = new URL(request.url).searchParams.get("dry") !== "1";
  try {
    const result = await trackCron(
      apply ? "fit-dims" : "fit-dims-dryrun",
      () => syncFitDims({ apply }),
      (r) => `products=${r.products} toWrite=${r.toWrite} unchanged=${r.unchanged} conflicts=${r.pageSizeConflict}` +
        `${r.dryRun ? " [dry-run]" : ` written=${r.written} failed=${r.failed}${r.deferred ? ` deferred=${r.deferred}` : ""}`}`,
    );
    const { plan, conflicts, ...summary } = result;
    return NextResponse.json(
      { success: true, data: { ...summary, sample: plan.slice(0, 10).map((p) => p.handle), conflictSample: conflicts.slice(0, 10) } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/cron/fit-dims failed:", err);
    return NextResponse.json({ success: false, error: "fit-dims failed" }, { status: 500 });
  }
}
