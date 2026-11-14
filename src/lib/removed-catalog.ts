/**
 * "Removed from feed" reconcile — closes the oversell window for products that
 * VANISH from the Aosom CSV entirely (not qty=0, but gone). The daily sync's
 * diffProductsLight reports these as `removed` but never acted on them, so their
 * qty froze at the last value and they stayed active + buyable on Shopify until
 * the 30-day stale-catalog net (or never, if tagged exclude-stale). This handles
 * them IMMEDIATELY at sync time:
 *
 *   1. qty → 0 in Turso for removed SKUs (except rename-suspects + exclude-stale)
 *   2. Shopify DRAFT for products whose EVERY variant is gone from the feed
 *      (except exclude-stale + rename-suspects)
 *
 * Rename guard: Aosom sometimes renames a SKU's variant suffix (e.g. `84D-082` →
 * `84D-082V00BG`, `838-075` → `838-075WT`) without discontinuing the product. An
 * exact-SKU match would wrongly draft a still-available product, so a removed SKU
 * that has a prefix-relative still in the feed is treated as a possible rename and
 * left untouched — the 30-day stale-catalog net remains the secondary safeguard.
 *
 * Feed-completeness guard: a truncated/garbage CSV would make every SKU look
 * "gone" and mass-draft the catalog. If the feed covers < MIN_ACTIVE_COVERAGE of
 * ACTIVE products' variant SKUs, the plan produces NO writes.
 *
 * The decision core (`planRemovedFromFeed`) is pure (no I/O) so it is unit-testable;
 * `runRemovedFromFeedDraft` wires it to Turso + Shopify.
 */
import type { ShopifyExistingProduct } from "@/types/sync";
import { fetchAllShopifyProducts, draftShopifyProduct } from "@/lib/shopify-client";
import { zeroQtyForRemovedSkus, getCatalogFreshnessCandidates, type CatalogFreshnessCandidate } from "@/lib/database";
import { EXCLUDE_TAG } from "@/lib/stale-catalog";

/** Minimum fraction of ACTIVE products' variant SKUs the feed must cover before we
 * trust it enough to draft. Below this the feed looks truncated → no action. */
export const MIN_ACTIVE_COVERAGE = 0.8;
/** Spacing between Shopify draft writes → 2 requests/second (Shopify Admin limit). */
export const RATE_LIMIT_MS = 500;
/** A prefix relation only counts as a possible rename when the shorter SKU is at least
 * this long — avoids matching on trivially short shared prefixes. */
export const RENAME_MIN_LEN = 6;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * True if `sku` has a prefix-relative in the feed (one is a strict prefix of the
 * other, shared length ≥ RENAME_MIN_LEN) — a likely Aosom SKU-rename, so the product
 * is probably still available under the neighbouring SKU. Exact matches are the
 * caller's "present in feed" case and never reach here.
 */
export function isRenameSuspect(sku: string, feedSkuList: string[]): boolean {
  const u = sku.toUpperCase();
  if (u.length < RENAME_MIN_LEN) return false;
  for (const f of feedSkuList) {
    if (f === u) continue;
    const min = Math.min(f.length, u.length);
    if (min < RENAME_MIN_LEN) continue;
    if (f.startsWith(u) || u.startsWith(f)) return true;
  }
  return false;
}

export interface RemovedPlanInput {
  /** DB SKUs absent from today's feed (diffResult.removed). */
  removedSkus: string[];
  /** All feed SKUs today, UPPERCASE. */
  feedSkus: Set<string>;
  /** All feed SKUs today, UPPERCASE, as a list (prefix scan for rename detection). */
  feedSkuList: string[];
  shopifyProducts: ShopifyExistingProduct[];
  minActiveCoverage?: number;
}

export interface RemovedPlan {
  guard: { activeSkus: number; coveredSkus: number; coverage: number; ok: boolean };
  /** SKUs to set qty=0 in Turso. */
  qtyZeroSkus: string[];
  /** Products to draft on Shopify (every variant gone, active, not excluded/rename). */
  drafts: Array<{ shopifyId: string; title: string; skus: string[] }>;
  skipped: { renameSuspect: number; excludeStale: number; alreadyInactive: number };
}

/** Pure decision core — no I/O. */
export function planRemovedFromFeed(input: RemovedPlanInput): RemovedPlan {
  const { removedSkus, feedSkus, feedSkuList, shopifyProducts } = input;
  const minCoverage = input.minActiveCoverage ?? MIN_ACTIVE_COVERAGE;
  const feedHas = (sku: string) => feedSkus.has(sku.toUpperCase());

  // Feed-completeness guard over ACTIVE products' variant SKUs. Already-drafted
  // discontinued products are excluded from the denominator so accumulated churn
  // doesn't drag the ratio down (that would falsely look like a truncated feed).
  let activeSkus = 0;
  let coveredSkus = 0;
  for (const p of shopifyProducts) {
    if (p.status !== "active") continue;
    for (const v of p.variants) {
      if (!v.sku) continue;
      activeSkus++;
      if (feedHas(v.sku)) coveredSkus++;
    }
  }
  const coverage = activeSkus === 0 ? 1 : coveredSkus / activeSkus;
  const ok = coverage >= minCoverage;
  const guard = { activeSkus, coveredSkus, coverage, ok };
  if (!ok) {
    return { guard, qtyZeroSkus: [], drafts: [], skipped: { renameSuspect: 0, excludeStale: 0, alreadyInactive: 0 } };
  }

  // The set the diff flagged as gone (DB SKUs absent from feed). Drafting is
  // intersected with this so we NEVER unpublish a product whose SKUs were never
  // in the DB/feed to begin with (manually-created / non-Aosom / bundle products).
  const removedSet = new Set(removedSkus.map((s) => s.toUpperCase()));
  const excludeStaleIds = new Set(
    shopifyProducts
      .filter((p) => p.tags.some((t) => t.toLowerCase() === EXCLUDE_TAG))
      .map((p) => p.shopifyId),
  );
  const productBySku = new Map<string, ShopifyExistingProduct>();
  for (const p of shopifyProducts) {
    for (const v of p.variants) if (v.sku) productBySku.set(v.sku.toUpperCase(), p);
  }
  const renameCache = new Map<string, boolean>();
  const rename = (sku: string) => {
    const u = sku.toUpperCase();
    let hit = renameCache.get(u);
    if (hit === undefined) { hit = isRenameSuspect(u, feedSkuList); renameCache.set(u, hit); }
    return hit;
  };

  // qty→0 for removed SKUs that map to a live Shopify variant, excluding rename
  // suspects and any variant of an exclude-stale product.
  const qtyZeroSkus = removedSkus.filter((sku) => {
    if (feedHas(sku)) return false;                // still in feed under different case → not gone
    const p = productBySku.get(sku.toUpperCase());
    if (!p) return false;                          // not a live Shopify variant
    if (excludeStaleIds.has(p.shopifyId)) return false;
    if (rename(sku)) return false;
    return true;
  });

  // Draft products whose EVERY variant is gone from the feed (product-level, like
  // computeDiffs' archive path), active, not exclude-stale, no rename-suspect variant.
  const drafts: RemovedPlan["drafts"] = [];
  let renameSuspect = 0, excludeStale = 0, alreadyInactive = 0;
  for (const p of shopifyProducts) {
    const skus = p.variants.map((v) => v.sku).filter((s): s is string => !!s);
    if (skus.length === 0) continue;
    if (!skus.every((s) => !feedHas(s))) continue;   // some variant still in feed → keep live
    // Only draft products the diff actually flagged as removed — never a product
    // whose SKUs were never in the DB/feed (manual / non-Aosom product). F1 guard.
    if (!skus.some((s) => removedSet.has(s.toUpperCase()))) continue;
    if (excludeStaleIds.has(p.shopifyId)) { excludeStale++; continue; }
    if (skus.some((s) => rename(s))) { renameSuspect++; continue; }
    if (p.status !== "active") { alreadyInactive++; continue; }
    drafts.push({ shopifyId: p.shopifyId, title: p.title, skus });
  }

  return { guard, qtyZeroSkus, drafts, skipped: { renameSuspect, excludeStale, alreadyInactive } };
}

export interface RemovedRunResult {
  ran: boolean;
  guardTripped: boolean;
  coverage: number;
  qtyZeroed: number;
  drafted: number;
  failed: number;
  skipped: RemovedPlan["skipped"];
  planned: number;
}

export interface RemovedRunDeps {
  fetchShopify?: () => Promise<ShopifyExistingProduct[]>;
  draft?: (shopifyId: string) => Promise<void>;
  zeroQty?: (skus: string[]) => Promise<number>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  rateLimitMs?: number;
  /** Pre-fetched Shopify products (skip the fetch when the caller already has them). */
  shopifyProducts?: ShopifyExistingProduct[];
}

const defaultLog = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "removed-catalog", msg, ...extra }));

/**
 * Wire the plan to Turso + Shopify. Non-throwing on the guard (returns guardTripped);
 * per-product draft failures are caught and counted, never abort the batch.
 */
export async function runRemovedFromFeedDraft(
  removedSkus: string[],
  feedSkus: Set<string>,
  deps: RemovedRunDeps = {},
): Promise<RemovedRunResult> {
  const log = deps.log ?? defaultLog;
  const empty: RemovedRunResult = {
    ran: false, guardTripped: false, coverage: 1, qtyZeroed: 0, drafted: 0, failed: 0,
    skipped: { renameSuspect: 0, excludeStale: 0, alreadyInactive: 0 }, planned: 0,
  };
  if (removedSkus.length === 0) return empty;

  const shopifyProducts = deps.shopifyProducts ?? (await (deps.fetchShopify ?? fetchAllShopifyProducts)());
  const feedSkuList = [...feedSkus];
  const plan = planRemovedFromFeed({ removedSkus, feedSkus, feedSkuList, shopifyProducts });

  if (!plan.guard.ok) {
    log(`GARDE-FOU: couverture actifs ${(plan.guard.coverage * 100).toFixed(1)}% < ${MIN_ACTIVE_COVERAGE * 100}% — feed suspect, aucune action`, {
      active_skus: plan.guard.activeSkus, covered_skus: plan.guard.coveredSkus,
    });
    return { ...empty, ran: true, guardTripped: true, coverage: plan.guard.coverage };
  }

  const zeroQty = deps.zeroQty ?? zeroQtyForRemovedSkus;
  const draft = deps.draft ?? draftShopifyProduct;
  const rate = deps.rateLimitMs ?? RATE_LIMIT_MS;

  const qtyZeroed = await zeroQty(plan.qtyZeroSkus);
  log(`qty→0 pour ${qtyZeroed} SKU(s) disparus du feed`, { removed: removedSkus.length, planned_zero: plan.qtyZeroSkus.length });

  let drafted = 0, failed = 0;
  for (const d of plan.drafts) {
    try {
      await draft(d.shopifyId);
      drafted++;
      log(`removed_from_feed: drafté "${d.title}"`, { reason: "removed_from_feed", shopify_id: d.shopifyId, skus: d.skus });
    } catch (err) {
      failed++;
      log(`removed_from_feed draft échec ${d.shopifyId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rate > 0) await wait(rate);
  }

  log(`removed-from-feed terminé: ${drafted} draftés, ${failed} échecs, ${qtyZeroed} qty→0`, {
    rename_suspects_skipped: plan.skipped.renameSuspect,
    exclude_stale_skipped: plan.skipped.excludeStale,
    already_inactive: plan.skipped.alreadyInactive,
  });
  return {
    ran: true, guardTripped: false, coverage: plan.guard.coverage,
    qtyZeroed, drafted, failed, skipped: plan.skipped, planned: plan.drafts.length,
  };
}

/**
 * Catalog-freshness zero-out — closes the gap `runRemovedFromFeedDraft` above
 * deliberately leaves open. That function only reaches SKUs already linked to a live
 * Shopify product (it needs a `shopifyId` to draft or a matched variant to zero); the
 * ~8,953 catalog rows that were NEVER imported have no such link, so a product Aosom
 * quietly discontinued long ago can sit in the Catalogue browser forever with its last
 * known qty still showing (2026-09-20 investigation: rows up to 163 days stale, ~3,477
 * not reconfirmed in 7+ days). This rule is simpler and SKU-population-agnostic: ANY
 * product row — imported or not — whose last confirmed presence in the Aosom feed
 * (`last_seen_at`) is older than CATALOG_FRESHNESS_ZERO_DAYS gets qty→0.
 *
 * Not the same thing as stale-catalog.ts's STALE_DAYS=30 net: that one runs on its own
 * weekly cron and DRAFTS already-imported, still-live Shopify products. This one runs
 * daily inside job1-sync's runSyncInit (same cadence as runRemovedFromFeedDraft above)
 * and only ever touches the local `qty` column — it never calls Shopify, because a
 * never-imported row has nothing on Shopify to touch.
 *
 * No feed-completeness guard (unlike the function above): a single truncated CSV day
 * can't falsely trip this rule, because the 21-day window means a genuinely available
 * product will have a recent last_seen_at from any of the last ~21 successful runs, not
 * just today's. And if the cron itself stops running, this code stops running with it
 * (last_seen_at simply stops advancing) — there's no scenario where an outage causes
 * new false positives.
 *
 * Idempotent: a SKU that reappears in tomorrow's feed is upserted with its real qty by
 * the normal refreshProducts() path regardless of having been zeroed — there is no
 * separate "excluded forever" flag to clear, see the 2026-09-20 investigation.
 */
export const CATALOG_FRESHNESS_ZERO_DAYS = 21;

/** Pure decision core — no I/O. SKUs already at qty=0 are excluded (nothing to do). */
export function planCatalogFreshnessZero(
  candidates: CatalogFreshnessCandidate[],
  nowSeconds: number,
  thresholdDays: number = CATALOG_FRESHNESS_ZERO_DAYS,
): string[] {
  const cutoff = nowSeconds - thresholdDays * 86400;
  return candidates
    .filter((c) => c.qty !== 0 && c.lastSeenAt < cutoff)
    .map((c) => c.sku);
}

export interface CatalogFreshnessZeroResult {
  /** Rows examined (qty != 0, any SKU). */
  candidates: number;
  /** Rows whose last_seen_at was past the threshold. */
  planned: number;
  /** Rows actually written qty=0 (matches `planned` in practice; kept separate for
   * consistency with the write result, same shape as zeroQtyForRemovedSkus's return). */
  zeroed: number;
}

export interface CatalogFreshnessZeroDeps {
  getCandidates?: () => Promise<CatalogFreshnessCandidate[]>;
  zeroQty?: (skus: string[]) => Promise<number>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: number;
  thresholdDays?: number;
}

export async function runCatalogFreshnessZero(
  deps: CatalogFreshnessZeroDeps = {},
): Promise<CatalogFreshnessZeroResult> {
  const log = deps.log ?? defaultLog;
  const getCandidates = deps.getCandidates ?? getCatalogFreshnessCandidates;
  const zeroQty = deps.zeroQty ?? zeroQtyForRemovedSkus;
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const thresholdDays = deps.thresholdDays ?? CATALOG_FRESHNESS_ZERO_DAYS;

  const candidates = await getCandidates();
  const skus = planCatalogFreshnessZero(candidates, now, thresholdDays);
  const zeroed = skus.length > 0 ? await zeroQty(skus) : 0;

  log(`catalog-freshness-zero: ${zeroed} SKU(s) mis à qty=0 (non revus depuis ≥${thresholdDays}j)`, {
    candidates: candidates.length, planned: skus.length, zeroed,
  });

  return { candidates: candidates.length, planned: skus.length, zeroed };
}
