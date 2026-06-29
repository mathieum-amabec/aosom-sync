import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { runPriceAuditAndCorrect, persistPriceAudit } from "@/lib/price-audit";
import { trackCron } from "@/lib/cron-tracking";

/**
 * GET /api/health/price-audit — audit + AUTO-CORRECTION. Compares the live Shopify price of
 * every variant against `products.price` (the Aosom feed price = the FLOOR), and for every
 * variant priced below it, immediately pushes the corrected (floor) price back to Shopify and
 * logs it to price_history (change_type='floor_correction').
 *
 * Protected by CRON_SECRET (Bearer). Returns { total, below_floor, corrected, failed,
 * items, corrections } where each correction carries status 'corrected' | 'failed'. Also
 * persists a compact summary to settings so the dashboard "Alertes" panel can show
 * green (auto-corrected) / red (failed) without re-running the expensive Shopify fetch.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Wrap in trackCron so the run (success/error) lands in `cron_runs` like the other
    // crons — without it, price-audit was invisible to the dashboard cron-health view and
    // there was no run/outcome trail. The detail summarizes what the run did.
    const result = await trackCron(
      "price-audit",
      async () => {
        const r = await runPriceAuditAndCorrect();
        await persistPriceAudit(r, Math.floor(Date.now() / 1000));
        return r;
      },
      (r) => `corrected=${r.corrected} failed=${r.failed} deferred=${r.deferred} violations=${r.below_floor}`,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/health/price-audit failed:", err);
    return NextResponse.json({ error: "Price audit failed" }, { status: 500 });
  }
}
