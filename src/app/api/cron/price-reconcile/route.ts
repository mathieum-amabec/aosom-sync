import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { runPriceReconcile, advanceReconcileCheckpoint, formatSweepCompleteAlert } from "@/lib/price-reconcile";
import {
  getProductsForPriceAudit,
  createNotification,
  recordPriceCorrections,
  getPriceReconcileCheckpoint,
  savePriceReconcileCheckpoint,
} from "@/lib/database";
import { updateShopifyVariantPrice, fetchVariant, fetchShopifyVariantsPage } from "@/lib/shopify-client";

/**
 * GET /api/cron/price-reconcile — LAYER 2. Hourly Turso↔Shopify price reconciliation,
 * rotating one Shopify page (250 variants) per run instead of the whole catalog.
 *
 * Compares that page's variants against the price Turso says they should have and
 * corrects the difference, in BOTH directions. This is the backstop for the daily push's
 * hard ceiling: `runShopifyPush` applies at most SHOPIFY_PUSH_CHUNK_SIZE (10) groups per
 * cron run × 3 runs = 30/day, against ~1,500 pending diffs, and discards the remainder at
 * midnight. Without this route a price change reached the storefront essentially at random.
 *
 * It is deliberately NOT the same thing as `/api/health/price-audit`, which only pushes
 * prices UP to the Aosom floor. An Aosom price DROP leaves us more expensive than the
 * supplier, and the floor audit will never touch it. This route fixes that direction too.
 *
 * ROTATION (not a full-catalog fetch every run): this used to page through the ENTIRE
 * catalog on every hourly invocation. Reliable at ~3000 variants, but a single Shopify
 * rate-limit mid-fetch threw away that whole hour's coverage (observed 2026-09-22 01:00
 * UTC) — and every added SKU makes the all-at-once fetch slower and more fragile. The
 * PriceReconcileCheckpoint (database.ts) resumes from the Shopify page_info cursor the
 * previous run left off at, so each invocation's API footprint is one page (250
 * variants, ~2s at the 2 req/s Admin limit) instead of the whole store. At ~250
 * variants/page and one page/hour, a full sweep of a ~3000-8000 variant catalog takes
 * roughly 12-32 hours — comfortably inside the "at least once a week" target with
 * headroom as the catalog grows. `MAX_CORRECTIONS_PER_RECONCILE` (300) stays as a
 * per-page safety valve; it's now well above a single page's size (250), so it should
 * essentially never trigger `deferred` in normal operation.
 *
 * Every write is read back and retried (writePriceVerified); anything that still fails
 * becomes a dashboard notification. A completed sweep also posts a summary notification
 * (formatSweepCompleteAlert) so "is this actually covering everything" has a visible
 * answer instead of needing to be reconstructed from raw logs.
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
    const checkpoint = await getPriceReconcileCheckpoint();
    const page = await fetchShopifyVariantsPage(checkpoint?.pageInfo ?? null);

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
          loadShopifyVariants: async () => page.variants,
          writePrice: (variantId, price, oldPrice) => updateShopifyVariantPrice(variantId, price, oldPrice),
          readVariant: (variantId) => fetchVariant(variantId),
          notify: (type, title, message) => createNotification(type, title, message),
          // Permanent traceability: one sync_logs row per applied correction.
          recordCorrections: (runId, entries) => recordPriceCorrections(runId, entries),
        }),
      (r) =>
        `page scanned=${r.scanned} drift=${r.drifted} corrected=${r.corrected} failed=${r.failed} deferred=${r.deferred} logged=${r.logged}`,
    );

    const nowEpoch = Math.floor(Date.now() / 1000);
    const { checkpoint: nextCheckpoint, completedSweep } = advanceReconcileCheckpoint(
      checkpoint,
      { nextPageInfo: page.nextPageInfo, scanned: result.scanned, drifted: result.drifted, corrected: result.corrected },
      nowEpoch,
    );
    await savePriceReconcileCheckpoint(nextCheckpoint);

    if (completedSweep) {
      const a = formatSweepCompleteAlert(completedSweep);
      await createNotification("price_reconcile_sweep", a.title, a.message);
    }

    return NextResponse.json(
      {
        success: true,
        scanned: result.scanned,
        drifted: result.drifted,
        corrected: result.corrected,
        failed: result.failed,
        deferred: result.deferred,
        runId: result.runId,
        logged: result.logged,
        // Every applied correction, so a manual run is auditable from the response alone.
        corrections: result.corrections,
        // Worst offenders only — the full list can be thousands of rows.
        worst: result.items.slice(0, 20),
        rotation: {
          sweepNumber: nextCheckpoint.sweepNumber,
          pagesThisSweep: nextCheckpoint.pagesThisSweep,
          variantsScannedThisSweep: nextCheckpoint.variantsScannedThisSweep,
          sweepCompleted: completedSweep !== null,
          lastSweepCompletedAt: nextCheckpoint.lastSweepCompletedAt,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[API] GET /api/cron/price-reconcile failed:", err);
    return NextResponse.json({ success: false, error: "price-reconcile failed" }, { status: 500 });
  }
}
