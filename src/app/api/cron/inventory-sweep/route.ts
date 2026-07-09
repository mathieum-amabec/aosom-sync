import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runInventorySweep } from "@/lib/inventory-sweep";

/**
 * GET /api/cron/inventory-sweep — the complete oversell guard. Feed-aware reconciliation over
 * EVERY active tracked Shopify variant (not just today-changed ones): sets each variant's
 * inventory to its feed target — 0 when the SKU is absent from the Aosom feed OR feed_qty <=
 * STOCK_SOLD_OUT_MAX (so inventory_policy=deny blocks the sale), else the buffered qty. Writes
 * only on a difference → idempotent AND self-healing (a variant zeroed on a transient feed miss
 * is restored next run). Variant-level (live siblings keep selling), no drafting. Aborts before
 * any write if the feed covers < 80% of active tracked variants (truncated-feed guard); a per-run
 * WRITE_CAP bounds blast radius (convergent). Protected by CRON_SECRET (Bearer), Shopify writes
 * rate-limited to 2 req/sec. cron_runs detail "scanned=N zeroed=X restored=Y …". Runs after the
 * daily Shopify push.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "inventory-sweep",
      () => runInventorySweep(),
      (r) => (r.guardTripped
        ? `GUARD tripped (coverage ${(r.coverage * 100).toFixed(1)}%) — no writes`
        : `scanned=${r.scanned} zeroed=${r.zeroed} restored=${r.restored} failed=${r.failed}${r.deferred ? ` deferred=${r.deferred}` : ""}`),
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/inventory-sweep failed:", err);
    return NextResponse.json({ success: false, error: "inventory-sweep failed" }, { status: 500 });
  }
}
