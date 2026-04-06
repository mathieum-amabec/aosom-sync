/**
 * Job 1 — Sync quotidienne
 *
 * 1. Fetch CSV Aosom + produits Shopify en parallèle
 * 2. Upsert tous les produits Aosom dans la table `products`
 * 3. Diff CSV ↔ Shopify (prix, stock, images)
 * 4. Auto-apply: prix, stock, images modifiées
 * 5. Log dans price_history + sync_runs
 */
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { mergeVariants } from "@/lib/variant-merger";
import { computeDiffs, summarizeDiffs } from "@/lib/diff-engine";
import type { AosomProduct } from "@/types/aosom";
import type { SyncLogEntry } from "@/types/sync";
import {
  fetchAllShopifyProducts,
  updateShopifyProduct,
  updateShopifyVariantPrice,
  draftShopifyProduct,
} from "@/lib/shopify-client";
import {
  createSyncRun,
  completeSyncRun,
  addSyncLogsBatch,
  refreshProducts,
  recordPriceChanges,
  getProduct,
  getSetting,
} from "@/lib/database";
import type { ChangeTypeHistory } from "@/lib/database";

function log(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[JOB1][${ts}] ${msg}`);
}

function aosomToProductRow(p: AosomProduct) {
  return {
    sku: p.sku,
    name: p.name,
    price: p.price,
    qty: p.qty,
    color: p.color,
    size: p.size,
    product_type: p.productType,
    image1: p.images[0] || "",
    image2: p.images[1] || "",
    image3: p.images[2] || "",
    image4: p.images[3] || "",
    image5: p.images[4] || "",
    image6: p.images[5] || "",
    image7: p.images[6] || "",
    video: p.video,
    description: p.description,
    short_description: p.shortDescription,
    material: p.material,
    gtin: p.gtin,
    weight: p.weight,
    out_of_stock_expected: p.outOfStockExpected,
    estimated_arrival: p.estimatedArrival,
    last_seen_at: Math.floor(Date.now() / 1000),
  };
}

export interface SyncResult {
  syncRunId: string;
  totalProducts: number;
  priceUpdates: number;
  stockChanges: number;
  newProducts: number;
  archived: number;
  errors: number;
  dryRun: boolean;
}

export async function runSync(options: { dryRun?: boolean } = {}): Promise<SyncResult> {
  const syncRun = createSyncRun();
  const isDryRun = options.dryRun ?? false;
  const errorMessages: string[] = [];
  let priceUpdates = 0;
  let stockChanges = 0;
  let newProducts = 0;
  let archived = 0;
  let errors = 0;

  try {
    // Step 1: Fetch data in parallel
    log("Fetch CSV Aosom + produits Shopify...");
    const [aosomProducts, shopifyProducts] = await Promise.all([
      fetchAosomCatalog(),
      fetchAllShopifyProducts(),
    ]);
    log(`${aosomProducts.length} produits Aosom, ${shopifyProducts.length} produits Shopify`);

    // Step 2: Detect changes BEFORE updating the DB
    // Compare current CSV prices/qty against what's in the products table
    const priceChangeEntries: {
      sku: string;
      oldPrice: number | null;
      newPrice: number | null;
      oldQty: number | null;
      newQty: number | null;
      changeType: ChangeTypeHistory;
    }[] = [];

    const priceDropThreshold = parseFloat(getSetting("social_price_drop_threshold") || "10");
    const socialDraftSkus: { sku: string; oldPrice: number; newPrice: number }[] = [];

    for (const csvProduct of aosomProducts) {
      const existing = getProduct(csvProduct.sku);
      if (!existing) {
        priceChangeEntries.push({
          sku: csvProduct.sku,
          oldPrice: null,
          newPrice: csvProduct.price,
          oldQty: null,
          newQty: csvProduct.qty,
          changeType: "new_product",
        });
        newProducts++;
      } else {
        // Price change
        if (Math.abs(existing.price - csvProduct.price) > 0.01) {
          const changeType: ChangeTypeHistory = csvProduct.price < existing.price ? "price_drop" : "price_increase";
          priceChangeEntries.push({
            sku: csvProduct.sku,
            oldPrice: existing.price,
            newPrice: csvProduct.price,
            oldQty: existing.qty,
            newQty: csvProduct.qty,
            changeType,
          });

          if (changeType === "price_drop") {
            const pctDrop = ((existing.price - csvProduct.price) / existing.price) * 100;
            if (pctDrop >= priceDropThreshold && existing.shopify_product_id) {
              log(`Prix réduit: ${csvProduct.sku} ${existing.price}$ → ${csvProduct.price}$ (-${pctDrop.toFixed(1)}%) — social draft queued`);
              socialDraftSkus.push({ sku: csvProduct.sku, oldPrice: existing.price, newPrice: csvProduct.price });
            }
          }
          priceUpdates++;
        }

        // Stock change
        if (existing.qty !== csvProduct.qty) {
          const isRestock = existing.qty === 0 && csvProduct.qty > 0;
          if (isRestock) {
            priceChangeEntries.push({
              sku: csvProduct.sku,
              oldPrice: existing.price,
              newPrice: csvProduct.price,
              oldQty: 0,
              newQty: csvProduct.qty,
              changeType: "restock",
            });
            log(`Restock: ${csvProduct.sku} 0 → ${csvProduct.qty} unités`);
          } else if (!priceChangeEntries.find((e) => e.sku === csvProduct.sku)) {
            priceChangeEntries.push({
              sku: csvProduct.sku,
              oldPrice: existing.price,
              newPrice: csvProduct.price,
              oldQty: existing.qty,
              newQty: csvProduct.qty,
              changeType: "stock_change",
            });
          }
          stockChanges++;
        }
      }
    }

    // Record all changes to price_history
    if (priceChangeEntries.length > 0) {
      recordPriceChanges(priceChangeEntries);
      log(`${priceChangeEntries.length} changements enregistrés dans price_history`);
    }

    if (isDryRun) {
      log("DRY RUN — aucune modification appliquée");
      completeSyncRun(syncRun.id, {
        status: "completed",
        totalProducts: aosomProducts.length,
        created: 0,
        updated: priceUpdates,
        archived: 0,
        errors: 0,
        errorMessages: ["DRY RUN — no changes applied"],
      });
      return {
        syncRunId: syncRun.id,
        totalProducts: aosomProducts.length,
        priceUpdates,
        stockChanges,
        newProducts,
        archived: 0,
        errors: 0,
        dryRun: true,
      };
    }

    // Step 3: Upsert all products into the products table
    log("Mise à jour de la table products...");
    refreshProducts(aosomProducts.map(aosomToProductRow));
    log(`${aosomProducts.length} produits upsertés`);

    // Step 4: Apply changes to Shopify
    log("Application des changements sur Shopify...");
    const merged = mergeVariants(aosomProducts);
    const diffs = computeDiffs(merged, shopifyProducts);
    const summary = summarizeDiffs(diffs);
    const logEntries: Omit<SyncLogEntry, "id">[] = [];
    const now = new Date().toISOString();
    const shopifyMap = new Map(shopifyProducts.map((p) => [p.shopifyId, p]));

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
          const priceChanges = diff.changes.filter((c) => c.field === "price");
          const shopifyProduct = shopifyMap.get(diff.shopifyId);
          await Promise.all(
            priceChanges.map((change) => {
              const shopifyVariant = shopifyProduct?.variants.find((v) => v.sku === change.sku);
              if (shopifyVariant && change.newValue !== null) {
                log(`Prix mis à jour: ${change.sku} ${change.oldValue}$ → ${change.newValue}$`);
                return updateShopifyVariantPrice(shopifyVariant.variantId, Number(change.newValue));
              }
            })
          );
        } else if (diff.action === "archive" && diff.shopifyId) {
          await draftShopifyProduct(diff.shopifyId);
          log(`Archivé: ${diff.groupKey}`);
          archived++;
        }

        for (const change of diff.changes) {
          logEntries.push({
            syncRunId: syncRun.id,
            timestamp: now,
            shopifyProductId: diff.shopifyId || null,
            sku: change.sku || diff.groupKey,
            action: diff.action,
            field: change.field,
            oldValue: change.oldValue !== null ? String(change.oldValue) : null,
            newValue: change.newValue !== null ? String(change.newValue) : null,
          });
        }
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        errorMessages.push(`${diff.action} ${diff.groupKey}: ${msg}`);
        log(`ERREUR: ${diff.action} ${diff.groupKey}: ${msg}`);
      }
    }

    if (logEntries.length > 0) {
      addSyncLogsBatch(logEntries);
    }

    completeSyncRun(syncRun.id, {
      status: errors > 0 && priceUpdates + archived === 0 ? "failed" : "completed",
      totalProducts: aosomProducts.length,
      created: 0,
      updated: summary.updates,
      archived,
      errors,
      errorMessages,
    });

    log(`Sync terminé: ${priceUpdates} prix, ${stockChanges} stocks, ${newProducts} nouveaux, ${archived} archivés, ${errors} erreurs`);

    // Trigger social drafts for significant price drops (async, non-blocking)
    if (socialDraftSkus.length > 0) {
      log(`Génération de ${socialDraftSkus.length} draft(s) social pour baisses de prix...`);
      import("@/jobs/job4-social").then(async ({ triggerPriceDrop }) => {
        for (const { sku, oldPrice, newPrice } of socialDraftSkus) {
          try {
            await triggerPriceDrop(sku, oldPrice, newPrice);
          } catch (err) {
            log(`Social draft failed for ${sku}: ${err}`);
          }
        }
      }).catch((err) => log(`Social module load failed: ${err}`));
    }

    return {
      syncRunId: syncRun.id,
      totalProducts: aosomProducts.length,
      priceUpdates,
      stockChanges,
      newProducts,
      archived,
      errors,
      dryRun: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERREUR FATALE: ${msg}`);
    completeSyncRun(syncRun.id, {
      status: "failed",
      totalProducts: 0,
      created: 0,
      updated: 0,
      archived: 0,
      errors: 1,
      errorMessages: [msg],
    });
    throw err;
  }
}
