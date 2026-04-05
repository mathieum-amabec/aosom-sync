import { fetchAosomCatalog } from "./csv-fetcher";
import { mergeVariants } from "./variant-merger";
import { computeDiffs, summarizeDiffs } from "./diff-engine";
import {
  fetchAllShopifyProducts,
  updateShopifyProduct,
  updateShopifyVariantPrice,
  draftShopifyProduct,
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
 * 2. Merge variants, compute diffs
 * 3. If not dry run: refresh snapshots + apply changes to Shopify
 * 4. Log everything
 */
export async function runDailySync(
  options: { dryRun?: boolean } = {}
): Promise<SyncResult> {
  const syncRun = createSyncRun();
  const errorMessages: string[] = [];
  let updated = 0;
  let archived = 0;
  let errors = 0;

  try {
    // Step 1: Fetch data in parallel
    const [aosomProducts, shopifyProducts] = await Promise.all([
      fetchAosomCatalog(),
      fetchAllShopifyProducts(),
    ]);

    // Step 2: Merge and diff
    const merged = mergeVariants(aosomProducts);
    const diffs = computeDiffs(merged, shopifyProducts);
    const summary = summarizeDiffs(diffs);

    if (options.dryRun) {
      completeSyncRun(syncRun.id, {
        status: "completed",
        totalProducts: merged.length,
        created: 0,
        updated: summary.updates,
        archived: summary.archives,
        errors: 0,
        errorMessages: ["DRY RUN — no changes applied"],
      });
      return { syncRun: { ...syncRun, status: "completed" }, diffs, summary };
    }

    // Step 3: Refresh catalog and history snapshots (only on real sync)
    refreshCatalogSnapshots(
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
    recordPriceSnapshots(aosomProducts.map((p) => ({ sku: p.sku, price: p.price })));
    recordStockSnapshots(aosomProducts.map((p) => ({ sku: p.sku, qty: p.qty })));

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

          // Price changes on variants (concurrent per product)
          const priceChanges = diff.changes.filter((c) => c.field === "price");
          await Promise.all(
            priceChanges.map((change) => {
              const shopifyVariant = shopifyProducts
                .find((p) => p.shopifyId === diff.shopifyId)
                ?.variants.find((v) => v.sku === change.sku);
              if (shopifyVariant && change.newValue !== null) {
                return updateShopifyVariantPrice(shopifyVariant.variantId, Number(change.newValue));
              }
            })
          );

          updated++;
        } else if (diff.action === "archive" && diff.shopifyId) {
          await draftShopifyProduct(diff.shopifyId);
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
      addSyncLogsBatch(logEntries);
    }

    completeSyncRun(syncRun.id, {
      status: errors > 0 && updated + archived === 0 ? "failed" : "completed",
      totalProducts: merged.length,
      created: 0,
      updated,
      archived,
      errors,
      errorMessages,
    });

    return {
      syncRun: { ...syncRun, status: "completed", created: 0, updated, archived, errors },
      diffs,
      summary,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMessages.push(msg);
    completeSyncRun(syncRun.id, {
      status: "failed",
      totalProducts: 0,
      created: 0,
      updated,
      archived,
      errors: errors + 1,
      errorMessages,
    });
    throw err;
  }
}
