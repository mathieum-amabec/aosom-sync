import { fetchAosomCatalog } from "./csv-fetcher";
import { mergeVariants } from "./variant-merger";
import { computeDiffs, summarizeDiffs } from "./diff-engine";
import {
  fetchAllShopifyProducts,
  updateShopifyProduct,
  updateShopifyVariantPrice,
  archiveShopifyProduct,
} from "./shopify-client";
import {
  createSyncRun,
  completeSyncRun,
  addSyncLogsBatch,
  refreshCatalogSnapshots,
  recordPriceSnapshots,
  recordStockSnapshots,
} from "./database";
import type { ProductDiff, SyncLogEntry, SyncRun } from "@/types/sync";

export interface SyncResult {
  syncRun: SyncRun;
  diffs: ProductDiff[];
  summary: ReturnType<typeof summarizeDiffs>;
}

/**
 * Run the daily sync pipeline:
 * 1. Fetch Aosom CSV + Shopify products in parallel
 * 2. Refresh catalog_snapshots in Turso
 * 3. Merge variants, compute diffs
 * 4. Apply price/image/status changes (no inventory sync — dropship)
 * 5. Log everything
 */
export async function runDailySync(
  options: { dryRun?: boolean } = {}
): Promise<SyncResult> {
  const syncRun = await createSyncRun();
  const errorMessages: string[] = [];
  let created = 0;
  let updated = 0;
  let archived = 0;
  let errors = 0;

  try {
    // Step 1: Fetch data in parallel
    const [aosomProducts, shopifyProducts] = await Promise.all([
      fetchAosomCatalog(),
      fetchAllShopifyProducts(),
    ]);

    // Step 2: Refresh catalog snapshots for the browser
    await refreshCatalogSnapshots(
      aosomProducts.map((p) => ({
        sku: p.sku,
        name: p.name,
        price: p.price,
        qty: p.qty,
        color: p.color,
        productType: p.productType,
        psin: p.psin,
        image: p.images[0] || "",
      }))
    );

    // Step 2b: Record price and stock snapshots for history tracking
    await recordPriceSnapshots(aosomProducts.map((p) => ({ sku: p.sku, price: p.price })));
    await recordStockSnapshots(aosomProducts.map((p) => ({ sku: p.sku, qty: p.qty })));

    // Step 3: Merge and diff
    const merged = mergeVariants(aosomProducts);
    const diffs = computeDiffs(merged, shopifyProducts);
    const summary = summarizeDiffs(diffs);

    if (options.dryRun) {
      await completeSyncRun(syncRun.id, {
        status: "completed",
        totalProducts: merged.length,
        created: summary.creates,
        updated: summary.updates,
        archived: summary.archives,
        errors: 0,
        errorMessages: ["DRY RUN — no changes applied"],
      });
      return { syncRun: { ...syncRun, status: "completed" }, diffs, summary };
    }

    // Step 4: Apply changes (price, images, archive only — no inventory/stock)
    const logEntries: Omit<SyncLogEntry, "id">[] = [];
    const now = new Date().toISOString();

    for (const diff of diffs) {
      try {
        if (diff.action === "update" && diff.shopifyId && diff.aosomProduct) {
          const productUpdates: Parameters<typeof updateShopifyProduct>[1] = {};
          const hasImageChange = diff.changes.some((c) => c.field === "images");
          const hasDescChange = diff.changes.some((c) => c.field === "description");

          if (hasImageChange) productUpdates.images = diff.aosomProduct.images;
          if (hasDescChange) productUpdates.bodyHtml = diff.aosomProduct.description;

          if (Object.keys(productUpdates).length > 0) {
            await updateShopifyProduct(diff.shopifyId, productUpdates);
          }

          // Price changes on variants
          for (const change of diff.changes.filter((c) => c.field === "price")) {
            const shopifyVariant = shopifyProducts
              .find((p) => p.shopifyId === diff.shopifyId)
              ?.variants.find((v) => v.sku === change.sku);
            if (shopifyVariant && change.newValue !== null) {
              await updateShopifyVariantPrice(shopifyVariant.variantId, Number(change.newValue));
            }
          }

          updated++;
        } else if (diff.action === "archive" && diff.shopifyId) {
          await archiveShopifyProduct(diff.shopifyId);
          archived++;
        }
        // Note: "create" action is NOT handled by daily sync.
        // New products go through the import pipeline with content generation.

        for (const change of diff.changes) {
          logEntries.push({
            syncRunId: syncRun.id,
            timestamp: now,
            shopifyProductId: diff.shopifyId,
            sku: change.sku,
            action: diff.action,
            field: change.field,
            oldValue: change.oldValue != null ? String(change.oldValue) : null,
            newValue: change.newValue != null ? String(change.newValue) : null,
          });
        }
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        errorMessages.push(`${diff.action} ${diff.groupKey}: ${msg}`);
      }
    }

    if (logEntries.length > 0) {
      await addSyncLogsBatch(logEntries);
    }

    await completeSyncRun(syncRun.id, {
      status: errors > 0 && updated + archived === 0 ? "failed" : "completed",
      totalProducts: merged.length,
      created,
      updated,
      archived,
      errors,
      errorMessages,
    });

    return {
      syncRun: { ...syncRun, status: "completed", created, updated, archived, errors },
      diffs,
      summary,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessages.push(msg);
    await completeSyncRun(syncRun.id, {
      status: "failed",
      totalProducts: 0,
      created,
      updated,
      archived,
      errors: errors + 1,
      errorMessages,
    });
    throw err;
  }
}
