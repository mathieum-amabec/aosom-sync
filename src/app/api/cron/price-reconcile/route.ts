import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runPriceReconcile } from "@/lib/price-reconcile";
import { getProductsForPriceAudit, createNotification } from "@/lib/database";
import { fetchAllShopifyProducts, updateShopifyVariantPrice, fetchVariant } from "@/lib/shopify-client";

/**
 * GET /api/cron/price-reconcile — LAYER 2. Hourly Turso↔Shopify price reconciliation.
 *
 * Compares every active Shopify variant against the price Turso says it should have and
 * corrects the difference, in BOTH directions. This is the backstop for the daily push's
 * hard ceiling: `runShopifyPush` applies at most SHOPIFY_PUSH_CHUNK_SIZE (10) groups per
 * cron run × 3 runs = 30/day, against ~1,500 pending diffs, and discards the remainder at
 * midnight. Without this route a price change reached the storefront essentially at random.
 *
 * It is deliberately NOT the same thing as `/api/health/price-audit`, which only pushes
 * prices UP to the Aosom floor. An Aosom price DROP leaves us more expensive than the
 * supplier, and the floor audit will never touch it. This route fixes that direction too.
 *
 * Every write is read back and retried (writePriceVerified); anything that still fails
 * becomes a dashboard notification. Capped at MAX_CORRECTIONS_PER_RECONCILE per run so a
 * large backlog drains over several hours instead of being SIGKILLed mid-write.
 *
 * Protected by CRON_SECRET (Bearer). Hourly.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await trackCron(
      "price-reconcile",
      () =>
        runPriceReconcile({
          loadExpectedPrices: async () => {
            const rows = await getProductsForPriceAudit();
            const m = new Map<string, number>();
            for (const r of rows) m.set(r.sku, r.price);
            return m;
          },
          loadShopifyVariants: async () => {
            const products = await fetchAllShopifyProducts();
            return products.flatMap((p) =>
              p.variants.map((v) => ({ sku: v.sku, price: v.price, variantId: v.variantId })),
            );
          },
          writePrice: (variantId, price, oldPrice) => updateShopifyVariantPrice(variantId, price, oldPrice),
          readVariant: (variantId) => fetchVariant(variantId),
          notify: (type, title, message) => createNotification(type, title, message),
        }),
      (r) => `scanned=${r.scanned} drift=${r.drifted} corrected=${r.corrected} failed=${r.failed} deferred=${r.deferred}`,
    );
    return NextResponse.json(
      {
        success: true,
        scanned: result.scanned,
        drifted: result.drifted,
        corrected: result.corrected,
        failed: result.failed,
        deferred: result.deferred,
        // Worst offenders only — the full list can be thousands of rows.
        worst: result.items.slice(0, 20),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/cron/price-reconcile failed:", err);
    return NextResponse.json({ success: false, error: "price-reconcile failed" }, { status: 500 });
  }
}
