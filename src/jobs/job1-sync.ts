/**
 * Job 1 — Sync quotidienne
 *
 * 1. Fetch CSV Aosom + produits Shopify en parallèle
 * 2. Detect changes (prix, stock, nouveaux produits)
 * 3. Upsert products + record price_history
 * 4. Apply diffs to Shopify (prix, stock, images, archives)
 * 5. Trigger social drafts for significant price drops
 */
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { mergeVariants } from "@/lib/variant-merger";
import { computeDiffs, summarizeDiffs } from "@/lib/diff-engine";
import { SYNC } from "@/lib/config";
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
  getAllProductsMap,
  getSetting,
  getLatestSyncRun,
} from "@/lib/database";
import type { ChangeTypeHistory } from "@/lib/database";

function log(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[JOB1][${ts}] ${msg}`);
}

// ─── Types ──────────────────────────────────────────────────────────

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

interface PriceChangeEntry {
  sku: string;
  oldPrice: number | null;
  newPrice: number | null;
  oldQty: number | null;
  newQty: number | null;
  changeType: ChangeTypeHistory;
}

interface ChangeDetectionResult {
  priceChangeEntries: PriceChangeEntry[];
  socialDraftSkus: { sku: string; oldPrice: number; newPrice: number }[];
  priceUpdates: number;
  stockChanges: number;
  newProducts: number;
}

// ─── Sub-functions ──────────────────────────────────────────────────

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

/** Compare CSV products against DB state, detect price/stock/new changes. */
function detectChanges(aosomProducts: AosomProduct[]): ChangeDetectionResult {
  const priceChangeEntries: PriceChangeEntry[] = [];
  const socialDraftSkus: { sku: string; oldPrice: number; newPrice: number }[] = [];
  const threshold = parseFloat(getSetting("social_price_drop_threshold") || SYNC.DEFAULT_PRICE_DROP_THRESHOLD);
  let priceUpdates = 0;
  let stockChanges = 0;
  let newProducts = 0;

  // Batch load all products to avoid N+1 queries (10k+ products)
  const productsMap = getAllProductsMap();
  const skusWithPriceChange = new Set<string>();

  for (const csv of aosomProducts) {
    const existing = productsMap.get(csv.sku) || null;
    if (!existing) {
      priceChangeEntries.push({ sku: csv.sku, oldPrice: null, newPrice: csv.price, oldQty: null, newQty: csv.qty, changeType: "new_product" });
      skusWithPriceChange.add(csv.sku);
      newProducts++;
      continue;
    }

    // Price change
    if (Math.abs(existing.price - csv.price) > SYNC.PRICE_TOLERANCE) {
      const changeType: ChangeTypeHistory = csv.price < existing.price ? "price_drop" : "price_increase";
      priceChangeEntries.push({ sku: csv.sku, oldPrice: existing.price, newPrice: csv.price, oldQty: existing.qty, newQty: csv.qty, changeType });
      skusWithPriceChange.add(csv.sku);

      if (changeType === "price_drop") {
        const pctDrop = ((existing.price - csv.price) / existing.price) * 100;
        if (pctDrop >= threshold && existing.shopify_product_id) {
          log(`Prix réduit: ${csv.sku} ${existing.price}$ → ${csv.price}$ (-${pctDrop.toFixed(1)}%) — social draft queued`);
          socialDraftSkus.push({ sku: csv.sku, oldPrice: existing.price, newPrice: csv.price });
        }
      }
      priceUpdates++;
    }

    // Stock change
    if (existing.qty !== csv.qty) {
      const isRestock = existing.qty === 0 && csv.qty > 0;
      if (isRestock) {
        priceChangeEntries.push({ sku: csv.sku, oldPrice: existing.price, newPrice: csv.price, oldQty: 0, newQty: csv.qty, changeType: "restock" });
        log(`Restock: ${csv.sku} 0 → ${csv.qty} unités`);
      } else if (!skusWithPriceChange.has(csv.sku)) {
        priceChangeEntries.push({ sku: csv.sku, oldPrice: existing.price, newPrice: csv.price, oldQty: existing.qty, newQty: csv.qty, changeType: "stock_change" });
      }
      stockChanges++;
    }
  }

  return { priceChangeEntries, socialDraftSkus, priceUpdates, stockChanges, newProducts };
}

/** Apply diffs (price, images, archives) to Shopify and log entries. */
async function applyToShopify(
  aosomProducts: AosomProduct[],
  shopifyProducts: Awaited<ReturnType<typeof fetchAllShopifyProducts>>,
  syncRunId: string,
): Promise<{ archived: number; errors: number; errorMessages: string[]; logEntries: Omit<SyncLogEntry, "id">[]; updates: number }> {
  const merged = mergeVariants(aosomProducts);
  const diffs = computeDiffs(merged, shopifyProducts);
  const summary = summarizeDiffs(diffs);
  const logEntries: Omit<SyncLogEntry, "id">[] = [];
  const now = new Date().toISOString();
  const shopifyMap = new Map(shopifyProducts.map((p) => [p.shopifyId, p]));
  const errorMessages: string[] = [];
  let archived = 0;
  let errors = 0;

  for (const diff of diffs) {
    try {
      if (diff.action === "update" && diff.shopifyId && diff.aosomProduct) {
        const productUpdates: Parameters<typeof updateShopifyProduct>[1] = {};
        if (diff.changes.some((c) => c.field === "images")) productUpdates.images = diff.aosomProduct.images;
        if (diff.changes.some((c) => c.field === "description")) productUpdates.bodyHtml = diff.aosomProduct.description;

        if (Object.keys(productUpdates).length > 0) {
          await updateShopifyProduct(diff.shopifyId, productUpdates);
        }

        const priceChanges = diff.changes.filter((c) => c.field === "price");
        const shopifyProduct = shopifyMap.get(diff.shopifyId);
        await Promise.all(
          priceChanges.map((change) => {
            const variant = shopifyProduct?.variants.find((v) => v.sku === change.sku);
            if (variant && change.newValue !== null) {
              log(`Prix mis à jour: ${change.sku} ${change.oldValue}$ → ${change.newValue}$`);
              return updateShopifyVariantPrice(variant.variantId, Number(change.newValue));
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
          syncRunId,
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

  return { archived, errors, errorMessages, logEntries, updates: summary.updates };
}

/** Fire-and-forget social draft generation for price drops. */
function triggerSocialDrafts(skus: { sku: string; oldPrice: number; newPrice: number }[]): void {
  if (skus.length === 0) return;
  log(`Génération de ${skus.length} draft(s) social pour baisses de prix...`);
  import("@/jobs/job4-social").then(async ({ triggerPriceDrop }) => {
    for (const { sku, oldPrice, newPrice } of skus) {
      try {
        await triggerPriceDrop(sku, oldPrice, newPrice);
      } catch (err) {
        log(`Social draft failed for ${sku}: ${err}`);
      }
    }
  }).catch((err) => log(`Social module load failed: ${err}`));
}

// ─── Main Entry Point ───────────────────────────────────────────────

export async function runSync(options: { dryRun?: boolean } = {}): Promise<SyncResult> {
  // Guard against concurrent sync runs
  const latestRun = getLatestSyncRun();
  if (latestRun && latestRun.status === "running") {
    throw new Error(`Sync already in progress (run ${latestRun.id}, started ${latestRun.startedAt})`);
  }

  const syncRun = createSyncRun();
  const isDryRun = options.dryRun ?? false;

  try {
    // Step 1: Fetch data in parallel
    log("Fetch CSV Aosom + produits Shopify...");
    const [aosomProducts, shopifyProducts] = await Promise.all([
      fetchAosomCatalog(),
      fetchAllShopifyProducts(),
    ]);
    log(`${aosomProducts.length} produits Aosom, ${shopifyProducts.length} produits Shopify`);

    // Step 2: Detect changes
    const changes = detectChanges(aosomProducts);

    // Dry run: report only, no mutations
    if (isDryRun) {
      log("DRY RUN — aucune modification appliquée");
      completeSyncRun(syncRun.id, {
        status: "completed", totalProducts: aosomProducts.length,
        created: 0, updated: changes.priceUpdates, archived: 0, errors: 0,
        errorMessages: ["DRY RUN — no changes applied"],
      });
      return { syncRunId: syncRun.id, totalProducts: aosomProducts.length, ...changes, archived: 0, errors: 0, dryRun: true };
    }

    // Step 3: Persist changes — upsert products FIRST (price_history has FK on products.sku)
    log("Mise à jour de la table products...");
    refreshProducts(aosomProducts.map(aosomToProductRow));
    log(`${aosomProducts.length} produits upsertés`);

    if (changes.priceChangeEntries.length > 0) {
      recordPriceChanges(changes.priceChangeEntries);
      log(`${changes.priceChangeEntries.length} changements enregistrés dans price_history`);
    }

    // Step 4: Apply to Shopify
    log("Application des changements sur Shopify...");
    const shopifyResult = await applyToShopify(aosomProducts, shopifyProducts, syncRun.id);

    if (shopifyResult.logEntries.length > 0) {
      addSyncLogsBatch(shopifyResult.logEntries);
    }

    completeSyncRun(syncRun.id, {
      status: shopifyResult.errors > 0 && shopifyResult.updates + shopifyResult.archived === 0 ? "failed" : "completed",
      totalProducts: aosomProducts.length,
      created: 0, updated: shopifyResult.updates, archived: shopifyResult.archived,
      errors: shopifyResult.errors, errorMessages: shopifyResult.errorMessages,
    });

    log(`Sync terminé: ${changes.priceUpdates} prix, ${changes.stockChanges} stocks, ${changes.newProducts} nouveaux, ${shopifyResult.archived} archivés, ${shopifyResult.errors} erreurs`);

    // Step 5: Trigger social drafts (non-blocking)
    triggerSocialDrafts(changes.socialDraftSkus);

    return {
      syncRunId: syncRun.id, totalProducts: aosomProducts.length,
      priceUpdates: changes.priceUpdates, stockChanges: changes.stockChanges,
      newProducts: changes.newProducts, archived: shopifyResult.archived,
      errors: shopifyResult.errors, dryRun: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERREUR FATALE: ${msg}`);
    completeSyncRun(syncRun.id, {
      status: "failed", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 1, errorMessages: [msg],
    });
    throw err;
  }
}
