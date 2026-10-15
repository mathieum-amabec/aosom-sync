import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { trackCron } from "@/lib/cron-tracking";
import { runSellPriceSync } from "@/lib/sell-price-sync";
import { defaultSellPriceDeps } from "@/lib/sell-price-db";

/**
 * GET /api/cron/sell-price-sync — daily (08:15 UTC, after the 06:00 Aosom sync and before the compare-at sync).
 * Computes `products.sell_price` for every Shopify-linked product: never below Aosom, a dollar under the competitor,
 * tiered markup otherwise (see sell-price-rule.ts). The hourly price reconcile and the Shopify push then move the
 * storefront to it.
 *
 * Controlled by `settings.pricing_mode` = off | dry | live (default off): `dry` stores a plan summary in
 * `pricing_last_plan` and changes nothing. `settings.pricing_max_changes_per_run` (default 500) rolls a large change
 * out over several days. Protected by CRON_SECRET (Bearer).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "sell-price-sync",
      () => runSellPriceSync({ deps: defaultSellPriceDeps() }),
      (r) =>
        `${r.mode}${r.skipped ? ` (${r.skipped})` : ""}: competitor=${r.competitorSource} changes=${r.plan.changes.length} applied=${r.applied} deferred=${r.plan.deferred} unchanged=${r.plan.unchanged} invalid=${r.plan.invalid}`,
    );
    return NextResponse.json({
      success: true,
      data: { mode: result.mode, skipped: result.skipped ?? null, competitor: result.competitorSource, planned: result.plan.changes.length, applied: result.applied, deferred: result.plan.deferred, byReason: result.plan.byReason },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "sell-price sync failed" }, { status: 500 });
  }
}
