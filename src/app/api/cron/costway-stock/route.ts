import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runCostwayStockSync, type CostwayStockMode } from "@/lib/costway/stock-sync";
import { defaultCostwayStockDeps } from "@/lib/costway/stock-sync-db";

/**
 * GET /api/cron/costway-stock — Costway stock → Shopify, per variant (see src/lib/costway/stock-sync.ts).
 * A variant Costway marks out of stock (or under 3 units) is set to 0 on Shopify; a restock re-opens it.
 * Mode = `settings.costway_stock_mode` (off | dry | live, default dry); `?mode=dry|live|off` overrides it for one call.
 * Runs after costway-sync (16:00 UTC). Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const m = new URL(request.url).searchParams.get("mode");
  const mode: CostwayStockMode | undefined = m === "dry" || m === "live" || m === "off" ? m : undefined;
  try {
    const result = await trackCron(
      "costway-stock",
      () => runCostwayStockSync({ deps: defaultCostwayStockDeps(), mode }),
      (r) =>
        `${r.mode}${r.skipped ? ` (${r.skipped})` : ""}: à changer=${r.plan.changes.length} (fermer=${r.plan.zeroing}) ` +
        `appliqué=${r.applied} échecs=${r.failed} reportés=${r.deferred} alignés=${r.plan.same} manquants=${r.plan.missing}`,
    );
    return NextResponse.json({ success: true, data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/costway-stock failed:", err);
    return NextResponse.json({ success: false, error: "costway-stock failed" }, { status: 500 });
  }
}
