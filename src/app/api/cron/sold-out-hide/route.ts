import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runSoldOutHide } from "@/lib/sold-out-hide-run";
import type { HideMode } from "@/lib/sold-out-hide";

/**
 * GET /api/cron/sold-out-hide — takes sold-out and out-of-season products off sale (DRAFT) and
 * brings them back when stock / the season returns. Rules in src/lib/sold-out-hide.ts.
 * `?mode=dry` plans without writing (the response lists every action); `?max=N` changes the
 * per-run write cap. Mode otherwise comes from `settings.sold_out_hide_mode` (default live).
 * Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const m = url.searchParams.get("mode");
  const mode: HideMode | undefined = m === "dry" || m === "live" || m === "off" ? m : undefined;
  const maxRaw = Number(url.searchParams.get("max"));
  const maxWrites = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(Math.floor(maxRaw), 500) : undefined;
  try {
    const result = await trackCron(
      mode === "dry" ? "sold-out-hide-dryrun" : "sold-out-hide",
      () => runSoldOutHide({ mode, maxWrites }),
      (r) => `${r.mode}: soldOut=${r.counts.hideSoldOut} season=${r.counts.hideSeason} mark=${r.counts.markSeason} reactivate=${r.counts.reactivate} release=${r.counts.releaseSeason} applied=${r.applied}${r.feedsRevalidated ? " feeds=revalidated" : ""}${r.deferred ? ` deferred=${r.deferred}` : ""}${r.failed ? ` failed=${r.failed}` : ""}${r.counts.skippedOpenOrder ? ` openOrder=${r.counts.skippedOpenOrder}` : ""}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/sold-out-hide failed:", err);
    return NextResponse.json({ success: false, error: "sold-out-hide failed" }, { status: 500 });
  }
}
