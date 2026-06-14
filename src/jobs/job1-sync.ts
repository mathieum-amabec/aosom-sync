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
  updateSyncRunTiming,
  addSyncLogsBatch,
  refreshProducts,
  rebuildProductTypeCounts,
  rebuildDiscountFlags,
  recordPriceChanges,
  purgeOldPriceHistory,
  purgeOldCronLogs,
  getProduct,
  getProductsSnapshot,
  getSetting,
  getLatestSyncRun,
  clearStaleLockIfNeeded,
  createNotification,
  getAllProductsAsAosom,
  getShopifyPushCheckpoint,
  saveShopifyPushCheckpoint,
  getPhase1Checkpoint,
  savePhase1Checkpoint,
  type ShopifyPushCheckpoint,
  type Phase1Checkpoint,
  type ProductSnapshot,
} from "@/lib/database";
import type { ChangeTypeHistory } from "@/lib/database";
import { diffProductsLight } from "@/lib/product-diff";
import {
  savePhase1Blob,
  readPhase1Blob,
  deletePhase1Blob,
  type Phase1BlobData,
} from "@/lib/sync-blob-storage";
import {
  tryAcquireSyncLock,
  releaseSyncLock,
  getSyncLockStatus,
} from "@/lib/sync-lock";

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "job1-sync", msg, ...extra }));
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

export interface PriceChangeEntry {
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

/** Compare CSV products against DB snapshot, detect price/stock/new changes. */
async function detectChanges(aosomProducts: AosomProduct[], snapshot: Map<string, ProductSnapshot>): Promise<ChangeDetectionResult> {
  const priceChangeEntries: PriceChangeEntry[] = [];
  const socialDraftSkus: { sku: string; oldPrice: number; newPrice: number }[] = [];
  const threshold = parseFloat(await getSetting("social_price_drop_threshold") || SYNC.DEFAULT_PRICE_DROP_THRESHOLD);
  let priceUpdates = 0;
  let stockChanges = 0;
  let newProducts = 0;

  const skusWithPriceChange = new Set<string>();

  for (const csv of aosomProducts) {
    const existing = snapshot.get(csv.sku) ?? null;
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

/** Apply pre-computed diffs to Shopify and log entries. */
async function applyToShopify(
  diffs: ReturnType<typeof computeDiffs>,
  shopifyProducts: Awaited<ReturnType<typeof fetchAllShopifyProducts>>,
  syncRunId: string,
): Promise<{ archived: number; errors: number; errorMessages: string[]; logEntries: Omit<SyncLogEntry, "id">[]; updates: number }> {
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
              const oldPrice = change.oldValue !== null ? Number(change.oldValue) : undefined;
              return updateShopifyVariantPrice(variant.variantId, Number(change.newValue), oldPrice);
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
  import("@/jobs/job4-social").then(async ({ triggerPriceDrop, maybeAutopostPriceDrop }) => {
    for (const { sku, oldPrice, newPrice } of skus) {
      try {
        const draft = await triggerPriceDrop(sku, oldPrice, newPrice);
        // Auto-post if enabled + threshold met + under daily limit
        await maybeAutopostPriceDrop(draft.draftId, oldPrice, newPrice);
      } catch (err) {
        log(`Social draft failed for ${sku}: ${err}`);
      }
    }
  }).catch((err) => log(`Social module load failed: ${err}`));
}

// ─── Main Entry Point ───────────────────────────────────────────────

export async function runSync(options: { dryRun?: boolean; shopifyPush?: boolean } = {}): Promise<SyncResult> {
  const t0Total = Date.now();
  const timing: Record<string, number> = {};

  // Phase 1: clearStaleLock
  const t0Lock = Date.now();
  await clearStaleLockIfNeeded();
  timing.clearStaleLock = Date.now() - t0Lock;
  log("clearStaleLock done", { phase: "clearStaleLock", duration_ms: timing.clearStaleLock });

  // Guard against concurrent sync runs
  const t0LatestRun = Date.now();
  const latestRun = await getLatestSyncRun();
  timing.getLatestSyncRun = Date.now() - t0LatestRun;
  log("getLatestSyncRun done", { phase: "getLatestSyncRun", duration_ms: timing.getLatestSyncRun });
  if (latestRun && latestRun.status === "running") {
    throw new Error(`Sync already in progress (run ${latestRun.id}, started ${latestRun.startedAt})`);
  }
  // F3: refuse manual trigger while Phase 1 chunked pipeline is running
  const todayForGuard = new Date().toISOString().slice(0, 10);
  const phase1Cp = await getPhase1Checkpoint();
  if (phase1Cp?.date === todayForGuard && !phase1Cp.finalized) {
    throw new Error(`Phase 1 chunked pipeline in progress (${phase1Cp.chunksProcessed}/${phase1Cp.totalChunks} chunks done). Wait for runSyncFull to finish (cron at 06:00/06:30 UTC) or use the manual fallback routes directly.`);
  }

  // Phase 2: createSyncRun
  const t0Create = Date.now();
  const syncRun = await createSyncRun();
  timing.createSyncRun = Date.now() - t0Create;
  log("createSyncRun done", { phase: "createSyncRun", duration_ms: timing.createSyncRun, syncRunId: syncRun.id });
  await updateSyncRunTiming(syncRun.id, timing);

  const isDryRun = options.dryRun ?? false;
  const shopifyPush = options.shopifyPush ?? true;

  try {
    // Phase 3: Fetch CSV + DB snapshot in parallel (+ Shopify if pushing this phase)
    log(shopifyPush ? "Fetch CSV Aosom + snapshot DB + produits Shopify..." : "Fetch CSV Aosom + snapshot DB...");
    const t0Fetch = Date.now();
    const [aosomProducts, snapshot, shopifyProducts] = await Promise.all([
      fetchAosomCatalog(),
      getProductsSnapshot(),
      shopifyPush ? fetchAllShopifyProducts() : Promise.resolve([] as Awaited<ReturnType<typeof fetchAllShopifyProducts>>),
    ]);
    timing.fetchAll = Date.now() - t0Fetch;
    log(`${aosomProducts.length} produits CSV, ${snapshot.size} en DB${shopifyPush ? `, ${shopifyProducts.length} Shopify` : ""}`, {
      phase: "fetchAll", duration_ms: timing.fetchAll,
      csv_count: aosomProducts.length, snapshot_count: snapshot.size,
      shopify_count: shopifyProducts.length,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    // Phase 4: Diff CSV vs snapshot — only write rows that actually changed
    const t0Diff = Date.now();
    const diffResult = diffProductsLight(aosomProducts, snapshot);
    const toWrite = [...diffResult.toInsert, ...diffResult.toUpdate];
    timing.diff = Date.now() - t0Diff;
    log(`Diff: ${diffResult.toInsert.length} nouveaux, ${diffResult.toUpdate.length} modifiés, ${diffResult.unchanged} inchangés, ${diffResult.removed.length} disparus`, {
      phase: "diff", duration_ms: timing.diff,
      to_insert: diffResult.toInsert.length, to_update: diffResult.toUpdate.length,
      unchanged: diffResult.unchanged, removed: diffResult.removed.length,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    // Phase 5: Detect price/stock changes on the changed subset
    const t0Detect = Date.now();
    const changes = await detectChanges(toWrite, snapshot);
    timing.detectChanges = Date.now() - t0Detect;
    log("detectChanges done", {
      phase: "detectChanges", duration_ms: timing.detectChanges,
      price_updates: changes.priceUpdates, stock_changes: changes.stockChanges,
      new_products: changes.newProducts, history_entries: changes.priceChangeEntries.length,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    // Dry run: report only, no mutations
    if (isDryRun) {
      log("DRY RUN — aucune modification appliquée");
      await completeSyncRun(syncRun.id, {
        status: "completed", totalProducts: aosomProducts.length,
        created: 0, updated: changes.priceUpdates, archived: 0, errors: 0,
        errorMessages: ["DRY RUN — no changes applied"],
      });
      return { syncRunId: syncRun.id, totalProducts: aosomProducts.length, ...changes, archived: 0, errors: 0, dryRun: true };
    }

    // Phase 6: Persist only changed rows (toInsert + toUpdate) — price_history FK on products.sku
    const t0Refresh = Date.now();
    if (toWrite.length > 0) {
      log(`Mise à jour de la table products (${toWrite.length}/${aosomProducts.length})...`);
      await refreshProducts(toWrite.map(aosomToProductRow));
      timing.refreshProducts = Date.now() - t0Refresh;
      log(`${toWrite.length} produits upsertés`, {
        phase: "refreshProducts", duration_ms: timing.refreshProducts, rows_written: toWrite.length,
      });
    } else {
      timing.refreshProducts = Date.now() - t0Refresh;
      log("Aucun produit modifié — refreshProducts ignoré", {
        phase: "refreshProducts", duration_ms: timing.refreshProducts, rows_written: 0,
      });
    }
    await updateSyncRunTiming(syncRun.id, timing);

    // Phase 7: Rebuild product type counts
    const t0Rebuild = Date.now();
    log("Mise à jour des compteurs de catégories...");
    await rebuildProductTypeCounts();
    timing.rebuildProductTypeCounts = Date.now() - t0Rebuild;
    log("rebuildProductTypeCounts done", { phase: "rebuildProductTypeCounts", duration_ms: timing.rebuildProductTypeCounts });
    await updateSyncRunTiming(syncRun.id, timing);

    // Phase 8: Record price history
    const t0Record = Date.now();
    if (changes.priceChangeEntries.length > 0) {
      await recordPriceChanges(changes.priceChangeEntries);
    }
    timing.recordPriceChanges = Date.now() - t0Record;
    log(`recordPriceChanges done`, {
      phase: "recordPriceChanges", duration_ms: timing.recordPriceChanges, entries: changes.priceChangeEntries.length,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    // Keep the precomputed has_discount flag in sync after a manual run too (same
    // rationale as the finalize path). Non-fatal: a stale flag is harmless.
    try {
      const t0Discount = Date.now();
      await rebuildDiscountFlags();
      timing.rebuildDiscountFlags = Date.now() - t0Discount;
      log("rebuildDiscountFlags done", { phase: "rebuildDiscountFlags", duration_ms: timing.rebuildDiscountFlags });
    } catch (discErr) {
      log(`rebuildDiscountFlags failed (non-fatal): ${discErr instanceof Error ? discErr.message : String(discErr)}`);
    }
    await updateSyncRunTiming(syncRun.id, timing);

    // Step 4: Apply to Shopify (skip if shopifyPush=false for cron phase 1)
    let shopifyResult = { archived: 0, errors: 0, errorMessages: [] as string[], logEntries: [] as Omit<SyncLogEntry, "id">[], updates: 0 };

    if (shopifyPush) {
      log("Application des changements sur Shopify...");
      const t0Shopify = Date.now();
      const mergedForPush = mergeVariants(aosomProducts);
      const diffsForPush = computeDiffs(mergedForPush, shopifyProducts);
      shopifyResult = await applyToShopify(diffsForPush, shopifyProducts, syncRun.id);
      timing.applyToShopify = Date.now() - t0Shopify;
      log("applyToShopify done", { phase: "applyToShopify", duration_ms: timing.applyToShopify, updates: shopifyResult.updates, archived: shopifyResult.archived });

      if (shopifyResult.logEntries.length > 0) {
        const t0Logs = Date.now();
        await addSyncLogsBatch(shopifyResult.logEntries);
        timing.addSyncLogsBatch = Date.now() - t0Logs;
        log("addSyncLogsBatch done", { phase: "addSyncLogsBatch", duration_ms: timing.addSyncLogsBatch, count: shopifyResult.logEntries.length });
      }
      await updateSyncRunTiming(syncRun.id, timing);
    } else {
      log("Shopify push différé (phase 2 séparée)");
    }

    const status = !shopifyPush ? "completed"
      : shopifyResult.errors > 0 && shopifyResult.updates + shopifyResult.archived === 0 ? "failed"
      : "completed";

    // Phase 9: completeSyncRun
    const t0Complete = Date.now();
    await completeSyncRun(syncRun.id, {
      status,
      totalProducts: aosomProducts.length,
      created: 0, updated: shopifyResult.updates, archived: shopifyResult.archived,
      errors: shopifyResult.errors,
      errorMessages: shopifyPush ? shopifyResult.errorMessages : ["DB sync only — Shopify push deferred"],
    });
    timing.completeSyncRun = Date.now() - t0Complete;
    timing.total = Date.now() - t0Total;
    log("completeSyncRun done", { phase: "completeSyncRun", duration_ms: timing.completeSyncRun });
    log(`Sync terminé: ${changes.priceUpdates} prix, ${changes.stockChanges} stocks, ${changes.newProducts} nouveaux, ${shopifyResult.archived} archivés, ${shopifyResult.errors} erreurs`, {
      phase: "total", duration_ms: timing.total,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    // Step 5: Notifications
    const parts: string[] = [];
    if (changes.priceUpdates > 0) parts.push(`${changes.priceUpdates} prix mis à jour`);
    if (changes.stockChanges > 0) parts.push(`${changes.stockChanges} stocks changés`);
    if (changes.newProducts > 0) parts.push(`${changes.newProducts} nouveaux produits`);
    if (shopifyResult.errors > 0) parts.push(`${shopifyResult.errors} erreurs`);
    if (!shopifyPush) parts.push("Shopify push en attente");
    const notifType = shopifyResult.errors > 0 ? "warning" : "success";
    const t0Notif = Date.now();
    await createNotification(notifType, "Sync terminée", parts.length > 0 ? parts.join(", ") : "Aucun changement détecté");
    timing.createNotification = Date.now() - t0Notif;

    // Step 6: Trigger social drafts (non-blocking)
    if (shopifyPush) {
      triggerSocialDrafts(changes.socialDraftSkus);
    }

    return {
      syncRunId: syncRun.id, totalProducts: aosomProducts.length,
      priceUpdates: changes.priceUpdates, stockChanges: changes.stockChanges,
      newProducts: changes.newProducts, archived: shopifyResult.archived,
      errors: shopifyResult.errors, dryRun: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    timing.total = Date.now() - t0Total;
    log(`ERREUR FATALE: ${msg}`, { phase: "error", duration_ms: timing.total });
    await updateSyncRunTiming(syncRun.id, timing);
    await completeSyncRun(syncRun.id, {
      status: "failed", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 1, errorMessages: [msg],
    });
    await createNotification("error", "Sync échouée", msg.slice(0, 200));
    throw err;
  }
}

/**
 * Phase 2: Apply pending Shopify diffs.
 * Fetches CSV + Shopify, computes diffs, applies only the Shopify mutations.
 * Designed to run as a separate cron job after the DB sync.
 */
const SHOPIFY_PUSH_CHUNK_SIZE = 10;

/**
 * Phase 2: Apply pending Shopify diffs.
 * Reads products from DB (no CSV re-fetch) and processes diffs in chunks of
 * SHOPIFY_PUSH_CHUNK_SIZE. Checkpoint is saved in settings so multiple cron
 * fires can resume where the previous one left off.
 *
 * Cron fires at "10,25,40 6 * * *" (every 15 min, up to 3 runs per day).
 * Each run clears stale locks, resumes the checkpoint if today's, and
 * processes one chunk before returning.
 */
export async function runShopifyPush(): Promise<{ updates: number; archived: number; errors: number }> {
  // Clear stale locks (>15 min) left by prior Vercel SIGKILL timeouts
  await clearStaleLockIfNeeded(15);

  const today = new Date().toISOString().slice(0, 10);

  // Read cross-cron checkpoint
  const existingCp = await getShopifyPushCheckpoint();
  const cp: ShopifyPushCheckpoint = existingCp?.date === today
    ? existingCp
    : { date: today, processedGroupKeys: [], totalDiffs: 0, totalUpdates: 0, totalArchived: 0, totalErrors: 0, done: false };

  if (cp.done) {
    log("Phase 2: déjà terminé pour aujourd'hui — rien à faire");
    return { updates: cp.totalUpdates, archived: cp.totalArchived, errors: cp.totalErrors };
  }

  // Create sync_run BEFORE the heavy fetch so the run is observable in DB even if
  // Vercel SIGKILLs the function during fetchAllShopifyProducts (which can take >300s).
  const syncRun = await createSyncRun();
  log(`Phase 2: Shopify push — sync run ${syncRun.id} créée, chunk (${cp.processedGroupKeys.length} déjà traités)`);

  try {
    // Fetch from DB (fast) + Shopify (needed for variant IDs and current prices)
    const [dbProducts, shopifyProducts] = await Promise.all([
      getAllProductsAsAosom(),
      fetchAllShopifyProducts(),
    ]);
    log(`${dbProducts.length} produits DB, ${shopifyProducts.length} produits Shopify`);

    const merged = mergeVariants(dbProducts);
    const allDiffs = computeDiffs(merged, shopifyProducts)
      .filter((d) => d.action !== "create"); // Phase 2 only applies updates + archives

    // Skip already-processed groupKeys
    const processedSet = new Set(cp.processedGroupKeys);
    const remaining = allDiffs.filter((d) => !processedSet.has(d.groupKey));

    if (remaining.length === 0) {
      log("Phase 2: tous les diffs déjà traités");
      await completeSyncRun(syncRun.id, {
        status: "completed", totalProducts: dbProducts.length,
        created: 0, updated: 0, archived: 0, errors: 0,
        errorMessages: ["Phase 2: no diffs remaining (checkpoint complete)"],
      });
      await saveShopifyPushCheckpoint({ ...cp, totalDiffs: allDiffs.length, done: true });
      return { updates: cp.totalUpdates, archived: cp.totalArchived, errors: cp.totalErrors };
    }

    const chunk = remaining.slice(0, SHOPIFY_PUSH_CHUNK_SIZE);
    log(`Phase 2: traitement chunk ${chunk.length}/${remaining.length} diffs restants`);

    const shopifyResult = await applyToShopify(chunk, shopifyProducts, syncRun.id);

    if (shopifyResult.logEntries.length > 0) {
      await addSyncLogsBatch(shopifyResult.logEntries);
    }

    await completeSyncRun(syncRun.id, {
      status: shopifyResult.errors > 0 && shopifyResult.updates + shopifyResult.archived === 0 ? "failed" : "completed",
      totalProducts: dbProducts.length,
      created: 0, updated: shopifyResult.updates, archived: shopifyResult.archived,
      errors: shopifyResult.errors, errorMessages: shopifyResult.errorMessages,
    });

    // Update cross-cron checkpoint
    const newProcessedKeys = [...cp.processedGroupKeys, ...chunk.map((d) => d.groupKey)];
    const newUpdates = cp.totalUpdates + shopifyResult.updates;
    const newArchived = cp.totalArchived + shopifyResult.archived;
    const newErrors = cp.totalErrors + shopifyResult.errors;
    const isDone = newProcessedKeys.length >= allDiffs.length;

    await saveShopifyPushCheckpoint({
      date: today,
      processedGroupKeys: newProcessedKeys,
      totalDiffs: allDiffs.length,
      totalUpdates: newUpdates,
      totalArchived: newArchived,
      totalErrors: newErrors,
      done: isDone,
    });

    log(`Phase 2 chunk terminé: ${shopifyResult.updates} updates, ${shopifyResult.archived} archivés, ${shopifyResult.errors} erreurs — ${isDone ? "COMPLET" : `${remaining.length - chunk.length} diffs restants`}`);

    if (isDone && (newUpdates > 0 || newArchived > 0 || newErrors > 0)) {
      const parts: string[] = [];
      if (newUpdates > 0) parts.push(`${newUpdates} produits mis à jour`);
      if (newArchived > 0) parts.push(`${newArchived} archivés`);
      if (newErrors > 0) parts.push(`${newErrors} erreurs`);
      await createNotification(
        newErrors > 0 ? "warning" : "success",
        "Shopify push terminé",
        parts.join(", "),
      );
    }

    return { updates: newUpdates, archived: newArchived, errors: newErrors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERREUR Phase 2 chunk: ${msg}`);
    try {
      await completeSyncRun(syncRun.id, {
        status: "failed", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 1, errorMessages: [msg],
      });
    } catch { /* ignore — DB failure after main error */ }
    throw err;
  }
}

// ─── Phase 1 chunked: init → refresh (×N) → finalize ───────────────────────

const REFRESH_CHUNK_SIZE = 2500;

export interface SyncInitResult {
  syncRunId: string;
  totalChunks: number;
  totalProducts: number;
  skipped: boolean;
}

export interface SyncRefreshResult {
  chunksProcessed: number;
  totalChunks: number;
  refreshDone: boolean;
  skipped: boolean;
}

export interface SyncFinalizeResult {
  skipped: boolean;
}

export interface SyncFullResult {
  skipped: boolean;
  reason?: string;
  totalChunks: number;
  chunksProcessed: number;
  totalProducts: number;
  lockHolder?: string;
  lockAgeSeconds?: number;
}

/**
 * Phase 1 init — fetchAll + diff + detectChanges + save blob.
 * Runs at 06:00 UTC. Completes quickly (<200s) regardless of catalog size.
 * Hands off refreshProducts work to sync-refresh crons via Phase1Checkpoint.
 */
export async function runSyncInit(): Promise<SyncInitResult> {
  const t0 = Date.now();
  const timing: Record<string, number> = {};
  const today = new Date().toISOString().slice(0, 10);

  const t0Lock = Date.now();
  await clearStaleLockIfNeeded();
  timing.clearStaleLock = Date.now() - t0Lock;

  const existingCp = await getPhase1Checkpoint();
  if (existingCp?.date === today) {
    log("Phase1 already initialized today — skipping", { phase: "init", finalized: existingCp.finalized });
    return { syncRunId: "", totalChunks: existingCp.totalChunks, totalProducts: existingCp.totalProducts, skipped: true };
  }

  const t0Latest = Date.now();
  const latestRun = await getLatestSyncRun();
  timing.getLatestSyncRun = Date.now() - t0Latest;
  if (latestRun && latestRun.status === "running") {
    throw new Error(`Sync already in progress (run ${latestRun.id}, started ${latestRun.startedAt})`);
  }

  const t0Create = Date.now();
  const syncRun = await createSyncRun();
  timing.createSyncRun = Date.now() - t0Create;
  await updateSyncRunTiming(syncRun.id, timing);

  try {
    const t0Fetch = Date.now();
    const [aosomProducts, snapshot] = await Promise.all([
      fetchAosomCatalog(),
      getProductsSnapshot(),
    ]);
    timing.fetchAll = Date.now() - t0Fetch;
    log(`${aosomProducts.length} produits CSV, ${snapshot.size} en DB`, {
      phase: "fetchAll", duration_ms: timing.fetchAll,
      csv_count: aosomProducts.length, snapshot_count: snapshot.size,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    const t0Diff = Date.now();
    const diffResult = diffProductsLight(aosomProducts, snapshot);
    const toWrite = [...diffResult.toInsert, ...diffResult.toUpdate];
    timing.diff = Date.now() - t0Diff;
    log(`Diff: ${diffResult.toInsert.length} nouveaux, ${diffResult.toUpdate.length} modifiés`, {
      phase: "diff", duration_ms: timing.diff,
      to_insert: diffResult.toInsert.length, to_update: diffResult.toUpdate.length,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    const t0Detect = Date.now();
    const changes = await detectChanges(toWrite, snapshot);
    timing.detectChanges = Date.now() - t0Detect;
    log("detectChanges done", {
      phase: "detectChanges", duration_ms: timing.detectChanges,
      price_updates: changes.priceUpdates, stock_changes: changes.stockChanges,
      new_products: changes.newProducts,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    const totalChunks = toWrite.length > 0 ? Math.ceil(toWrite.length / REFRESH_CHUNK_SIZE) : 0;

    const t0Blob = Date.now();
    let blobUrl = "";
    if (toWrite.length > 0) {
      const blobData: Phase1BlobData = {
        toWriteMapped: toWrite.map(aosomToProductRow),
        priceChangeEntries: changes.priceChangeEntries,
      };
      blobUrl = await savePhase1Blob(syncRun.id, blobData);
    }
    timing.saveBlob = Date.now() - t0Blob;
    log(`Blob saved (${toWrite.length} rows, ${totalChunks} chunks)`, {
      phase: "saveBlob", duration_ms: timing.saveBlob, rows: toWrite.length, total_chunks: totalChunks,
    });
    await updateSyncRunTiming(syncRun.id, timing);

    const cp: Phase1Checkpoint = {
      date: today,
      blobUrl,
      totalChunks,
      chunksProcessed: 0,
      refreshDone: totalChunks === 0,
      finalized: false,
      totalProducts: aosomProducts.length,
      priceUpdates: changes.priceUpdates,
      stockChanges: changes.stockChanges,
      newProducts: changes.newProducts,
    };
    await savePhase1Checkpoint(cp);

    const t0Complete = Date.now();
    await completeSyncRun(syncRun.id, {
      status: "completed",
      totalProducts: aosomProducts.length,
      created: 0, updated: 0, archived: 0, errors: 0,
      errorMessages: [`Phase 1 init — ${totalChunks} refresh chunks queued`],
    });
    timing.completeSyncRun = Date.now() - t0Complete;
    timing.total = Date.now() - t0;
    await updateSyncRunTiming(syncRun.id, timing);

    log(`runSyncInit done: ${totalChunks} chunks`, { phase: "total", duration_ms: timing.total });
    return { syncRunId: syncRun.id, totalChunks, totalProducts: aosomProducts.length, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    timing.total = Date.now() - t0;
    log(`ERREUR runSyncInit: ${msg}`, { phase: "error", duration_ms: timing.total });
    await updateSyncRunTiming(syncRun.id, timing);
    await completeSyncRun(syncRun.id, {
      status: "failed", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 1, errorMessages: [msg],
    });
    await createNotification("error", "Sync init échouée", msg.slice(0, 200));
    throw err;
  }
}

/**
 * Phase 1 refresh chunk — reads one REFRESH_CHUNK_SIZE slice from blob and writes to DB.
 * Each call is idempotent: advances chunksProcessed by exactly 1.
 * Runs at 06:20, 06:40, 07:00, 07:20 UTC until refreshDone=true.
 */
export async function runSyncRefreshChunk(): Promise<SyncRefreshResult> {
  const today = new Date().toISOString().slice(0, 10);
  const cp = await getPhase1Checkpoint();

  if (!cp || cp.date !== today || cp.refreshDone || cp.finalized) {
    log("Phase1 refresh: nothing to do", { phase: "refresh", hasCheckpoint: !!cp });
    return { chunksProcessed: 0, totalChunks: 0, refreshDone: true, skipped: true };
  }

  // Self-healing: clear orphan 'running' records left by prior Vercel SIGKILL or blob timeout.
  // Without this, stale locks accumulate across the 4 cron slots and block finalize.
  await clearStaleLockIfNeeded(15);

  const syncRun = await createSyncRun();

  try {
    const t0Read = Date.now();
    const blobData = await readPhase1Blob(cp.blobUrl);
    const start = cp.chunksProcessed * REFRESH_CHUNK_SIZE;
    const chunk = blobData.toWriteMapped.slice(start, start + REFRESH_CHUNK_SIZE);
    const readMs = Date.now() - t0Read;

    log(`Refresh chunk ${cp.chunksProcessed + 1}/${cp.totalChunks}: ${chunk.length} rows`, {
      phase: "refresh", chunk_index: cp.chunksProcessed, chunk_size: chunk.length, read_ms: readMs,
    });

    const t0Refresh = Date.now();
    await refreshProducts(chunk);
    const refreshMs = Date.now() - t0Refresh;
    log(`Chunk written`, { phase: "refresh", duration_ms: refreshMs, rows: chunk.length });

    // F2: re-read checkpoint to detect a concurrent invocation that already advanced it
    const freshCp = await getPhase1Checkpoint();
    if (!freshCp || freshCp.chunksProcessed !== cp.chunksProcessed) {
      log("Phase1 refresh: concurrent invocation already advanced checkpoint — skipping save", {
        phase: "refresh", expected: cp.chunksProcessed, actual: freshCp?.chunksProcessed,
      });
      return { chunksProcessed: freshCp?.chunksProcessed ?? cp.chunksProcessed + 1, totalChunks: cp.totalChunks, refreshDone: freshCp?.refreshDone ?? false, skipped: true };
    }

    const newChunksProcessed = cp.chunksProcessed + 1;
    const newRefreshDone = newChunksProcessed >= cp.totalChunks;
    await savePhase1Checkpoint({ ...cp, chunksProcessed: newChunksProcessed, refreshDone: newRefreshDone });

    await completeSyncRun(syncRun.id, {
      status: "completed",
      totalProducts: chunk.length,
      created: 0, updated: chunk.length, archived: 0, errors: 0,
      errorMessages: [`Phase 1 refresh chunk ${newChunksProcessed}/${cp.totalChunks}`],
    });

    return { chunksProcessed: newChunksProcessed, totalChunks: cp.totalChunks, refreshDone: newRefreshDone, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERREUR Phase1 refresh chunk: ${msg}`);
    try {
      await completeSyncRun(syncRun.id, {
        status: "failed", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 1, errorMessages: [msg],
      });
    } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Fluid Compute single-function orchestrator — replaces the 6-slot cron pipeline.
 * Runs at 06:00 UTC (maxDuration 800s, Vercel Pro Fluid Compute).
 * A retry slot at 06:30 UTC provides resilience via idempotency + resumability.
 *
 * Flow: init → sequential chunks loop → finalize
 * Idempotent: skips entirely if already finalized today.
 * Resumable: if interrupted mid-chunks, the 06:30 retry slot resumes from checkpoint.
 */
export async function runSyncFull(): Promise<SyncFullResult> {
  const today = new Date().toISOString().slice(0, 10);

  // Fast idempotency check — skip entirely if already finalized today
  const existingCp = await getPhase1Checkpoint();
  if (existingCp?.date === today && existingCp.finalized) {
    log("runSyncFull: already finalized today — skipping", { phase: "full" });
    return {
      skipped: true,
      reason: "Already finalized today",
      totalChunks: existingCp.totalChunks,
      chunksProcessed: existingCp.chunksProcessed,
      totalProducts: existingCp.totalProducts,
    };
  }

  // Atomic lock — prevent parallel executions (race condition guard)
  const holder = await tryAcquireSyncLock();
  if (!holder) {
    const lockStatus = await getSyncLockStatus();
    log("runSyncFull: lock held — skipping parallel call", {
      phase: "full",
      lockHolder: lockStatus?.holder,
      lockAgeSeconds: lockStatus?.ageSeconds,
    });
    return {
      skipped: true,
      reason: "Another sync in progress",
      totalChunks: existingCp?.totalChunks ?? 0,
      chunksProcessed: existingCp?.chunksProcessed ?? 0,
      totalProducts: existingCp?.totalProducts ?? 0,
      lockHolder: lockStatus?.holder,
      lockAgeSeconds: lockStatus?.ageSeconds,
    };
  }

  try {
    // Init (idempotent — skips if today's checkpoint already exists)
    const initResult = await runSyncInit();

    // Sequential chunks loop — each call reads checkpoint to find current position
    let refreshDone = false;
    let chunksProcessed = 0;
    while (!refreshDone) {
      const result = await runSyncRefreshChunk();
      refreshDone = result.refreshDone;
      if (!result.skipped) {
        chunksProcessed = result.chunksProcessed;
      }
    }

    // Finalize
    const finalizeResult = await runSyncFinalize();
    if (finalizeResult.skipped) {
      throw new Error("runSyncFinalize returned skipped=true unexpectedly after refresh completed — checkpoint may be in an inconsistent state");
    }

    return {
      skipped: false,
      totalChunks: initResult.totalChunks,
      chunksProcessed,
      totalProducts: initResult.totalProducts,
    };
  } finally {
    try {
      await releaseSyncLock(holder);
    } catch (releaseErr) {
      // DB unavailable at release time — TTL (900s) will clean up the stale lock.
      // Do not re-throw: would replace the original error or turn a successful sync into a 500.
      console.error("[sync-lock] Failed to release lock — TTL will clean up", releaseErr);
    }
  }
}

/**
 * Phase 1 finalize — rebuildProductTypeCounts + recordPriceChanges + completeSyncRun.
 * Runs at 07:40 UTC after all refresh chunks are done.
 */
export async function runSyncFinalize(): Promise<SyncFinalizeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const cp = await getPhase1Checkpoint();

  if (!cp || cp.date !== today || cp.finalized) {
    log("Phase1 finalize: not ready or already done", { phase: "finalize", hasCheckpoint: !!cp });
    return { skipped: true };
  }
  if (!cp.refreshDone) {
    const msg = `Phase1 finalize ignorée: refresh incomplet (${cp.chunksProcessed}/${cp.totalChunks} chunks)`;
    log(msg, { phase: "finalize" });
    await createNotification("error", "Sync finalize ignorée — refresh incomplet", msg.slice(0, 200));
    return { skipped: true };
  }

  const syncRun = await createSyncRun();

  try {
    let priceChangeEntries: PriceChangeEntry[] = [];
    if (cp.blobUrl) {
      try {
        const blobData = await readPhase1Blob(cp.blobUrl);
        priceChangeEntries = blobData.priceChangeEntries;
      } catch (blobErr) {
        log(`Blob read failed in finalize, skipping price history: ${blobErr}`);
      }
    }

    const t0Rebuild = Date.now();
    await rebuildProductTypeCounts();
    log("rebuildProductTypeCounts done", { phase: "finalize", duration_ms: Date.now() - t0Rebuild });

    const t0Record = Date.now();
    if (priceChangeEntries.length > 0) {
      await recordPriceChanges(priceChangeEntries);
    }
    log("recordPriceChanges done", { phase: "finalize", duration_ms: Date.now() - t0Record, entries: priceChangeEntries.length });

    // Refresh the precomputed has_discount flag now that today's price moves are in
    // price_history — keeps the catalog "Avec rabais" count/filter a single indexed
    // scan instead of a per-load correlated query. Non-fatal: a stale flag is harmless.
    try {
      const t0Discount = Date.now();
      await rebuildDiscountFlags();
      log("rebuildDiscountFlags done", { phase: "finalize", duration_ms: Date.now() - t0Discount });
    } catch (discErr) {
      const dmsg = discErr instanceof Error ? discErr.message : String(discErr);
      log(`rebuildDiscountFlags failed (non-fatal): ${dmsg}`, { phase: "finalize" });
      // Non-fatal for the sync, but a stale flag means the catalog "Avec rabais"
      // count/filter is wrong until the next successful rebuild — surface it.
      await createNotification("error", "Compteur rabais non recalculé", dmsg.slice(0, 200));
    }

    // Retention: drop price_history older than 90 days now that today's changes are
    // recorded. Caps Turso storage + the cost of the correlated discount query.
    // Non-fatal — a purge failure must not fail an otherwise-successful sync.
    try {
      const t0Purge = Date.now();
      const purged = await purgeOldPriceHistory(90);
      log("purgeOldPriceHistory done", { phase: "finalize", duration_ms: Date.now() - t0Purge, purged });
    } catch (purgeErr) {
      log(`purgeOldPriceHistory failed (non-fatal): ${purgeErr instanceof Error ? purgeErr.message : String(purgeErr)}`, { phase: "finalize" });
    }

    // Retention: trim cron_runs / feed_syncs audit logs older than 30 days. Both grow
    // unbounded and are scanned by the dashboard. Non-fatal — never fail the sync.
    try {
      const t0CronPurge = Date.now();
      const purgedLogs = await purgeOldCronLogs(30);
      log("purgeOldCronLogs done", { phase: "finalize", duration_ms: Date.now() - t0CronPurge, purged: purgedLogs });
    } catch (cronPurgeErr) {
      log(`purgeOldCronLogs failed (non-fatal): ${cronPurgeErr instanceof Error ? cronPurgeErr.message : String(cronPurgeErr)}`, { phase: "finalize" });
    }

    await completeSyncRun(syncRun.id, {
      status: "completed",
      totalProducts: cp.totalProducts,
      created: 0, updated: cp.priceUpdates, archived: 0, errors: 0,
      errorMessages: ["Phase 1 finalized — Shopify push deferred to Phase 2"],
    });

    // F6: mark finalized BEFORE deleting blob — if delete fails or checkpoint save fails
    // after delete, a retry would find no blob and silently skip price history.
    await savePhase1Checkpoint({ ...cp, finalized: true });
    if (cp.blobUrl) {
      await deletePhase1Blob(cp.blobUrl);
    }

    const parts: string[] = [];
    if (cp.priceUpdates > 0) parts.push(`${cp.priceUpdates} prix mis à jour`);
    if (cp.stockChanges > 0) parts.push(`${cp.stockChanges} stocks changés`);
    if (cp.newProducts > 0) parts.push(`${cp.newProducts} nouveaux produits`);
    parts.push("Shopify push en attente (Phase 2)");
    await createNotification("success", "Sync Phase 1 finalisée", parts.join(", ") || "Aucun changement");

    log("runSyncFinalize complete", { phase: "finalize", total_products: cp.totalProducts });
    return { skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERREUR Phase1 finalize: ${msg}`);
    try {
      await completeSyncRun(syncRun.id, {
        status: "failed", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 1, errorMessages: [msg],
      });
    } catch { /* ignore */ }
    await createNotification("error", "Sync finalize échouée", msg.slice(0, 200));
    throw err;
  }
}
