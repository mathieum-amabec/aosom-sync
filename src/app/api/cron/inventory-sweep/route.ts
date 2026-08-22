import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runInventorySweep } from "@/lib/inventory-sweep";

/**
 * GET /api/cron/inventory-sweep — the catalog-wide oversell guard. Feed-aware pass over
 * EVERY active tracked Shopify variant (not just today-changed ones): reconciles each variant
 * DOWN toward its buffered feed target — 0 when the SKU is absent from the Aosom feed OR
 * feed_qty <= STOCK_SOLD_OUT_MAX (so inventory_policy=deny blocks the sale), else feed_qty-3.
 * Downward-safe: writes a variant down whenever Shopify sits ABOVE the cap (over-count,
 * threshold change, failed push) and self-heals a fully-zeroed variant (0→N), but never tops a
 * sold-down nonzero variant back up (that would reopen intraday oversell against the 06:00
 * feed; left to the change-gated push). Writes only on a difference → idempotent. Variant-level
 * (live siblings keep selling), no drafting. Aborts before any write if the feed covers < 70% of
 * active tracked variants (truncated-feed guard) AND raises a dashboard notification so the abort
 * is never silent. After writing, a canary re-reads a sample of the just-written variants to
 * confirm the value stuck (notifies on mismatch). A per-run WRITE_CAP bounds blast radius
 * (convergent). Protected by CRON_SECRET (Bearer), Shopify writes rate-limited to 2 req/sec.
 * cron_runs detail "scanned=N zeroed=X restored=Y … verify=V/S". Runs after the daily Shopify push.
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
        ? `GUARD tripped (coverage ${(r.coverage * 100).toFixed(1)}%) — no writes, notified`
        : `scanned=${r.scanned} zeroed=${r.zeroed} restored=${r.restored} failed=${r.failed}${r.deferred ? ` deferred=${r.deferred}` : ""} verify=${r.verified}/${r.verified + r.verifyMismatch}${r.verifyMismatch ? " MISMATCH" : ""}`),
    );
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/cron/inventory-sweep failed:", err);
    return NextResponse.json({ success: false, error: "inventory-sweep failed" }, { status: 500 });
  }
}
