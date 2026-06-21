/**
 * Stale-catalog cleanup. Imported products that haven't appeared in the Aosom CSV for >N days
 * but are still in stock (qty>0) and live on Shopify are likely discontinued at Aosom — yet
 * still sellable on the storefront (oversell risk). This drafts them on Shopify.
 *
 * The decision logic (`computeStaleDrafts`) is dependency-injected (a status map + a draft fn)
 * so it is unit-testable without network. `runStaleCatalogDraft()` wires it to Turso + Shopify.
 * Mirrors the one-shot scripts/fix-stale-products.mjs, made idempotent: a product already
 * draft/archived on Shopify is skipped, and one that's gone (deleted) counts as failed.
 */
import { getStaleImportedProducts } from "@/lib/database";
import { fetchAllShopifyProducts, draftShopifyProduct } from "@/lib/shopify-client";

export const STALE_DAYS = 30;
/** Spacing between Shopify draft writes → 2 requests/second. */
export const RATE_LIMIT_MS = 500;
/**
 * Operator opt-out: a Shopify product carrying this tag is NEVER auto-drafted by
 * stale-catalog, regardless of staleness or stock. Apply it in the Shopify admin to
 * seasonal or still-procurable products you want to keep live even while absent from
 * the Aosom feed. Tags are already fetched by `fetchAllShopifyProducts`, so this costs
 * no extra API calls.
 */
export const EXCLUDE_TAG = "exclude-stale";

export interface StaleCatalogResult {
  /** Stale candidates found in the catalog. */
  stale: number;
  /** Newly drafted on Shopify this run. */
  drafted: number;
  /** Already draft/archived on Shopify — left alone. */
  skipped: number;
  /** Left live because the product carries the `exclude-stale` tag (operator opt-out). */
  excluded: number;
  /** Draft write failed, or the product no longer exists on Shopify. */
  failed: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure orchestration. For each stale product, decide what to do:
 * - in `excludedIds` (carries the `exclude-stale` tag) → leave live (operator opt-out)
 * - active   → draft it (rate-limited via `sleepMs`)
 * - draft/archived → skip
 * - absent from the map (deleted on Shopify) → failed
 * A thrown `draftFn` counts as failed and never aborts the batch.
 */
export async function computeStaleDrafts(
  stale: Array<{ sku: string; shopify_product_id: string }>,
  statusById: Map<string, string>,
  draftFn: (shopifyId: string) => Promise<void>,
  sleepMs: number = RATE_LIMIT_MS,
  excludedIds: Set<string> = new Set(),
): Promise<StaleCatalogResult> {
  let drafted = 0, skipped = 0, excluded = 0, failed = 0;
  for (const p of stale) {
    if (excludedIds.has(p.shopify_product_id)) { excluded++; continue; } // operator opt-out
    const status = statusById.get(p.shopify_product_id);
    if (status === undefined) { failed++; continue; }   // deleted on Shopify (stale id in our DB)
    if (status !== "active") { skipped++; continue; }    // already draft/archived
    try {
      await draftFn(p.shopify_product_id);
      drafted++;
    } catch (err) {
      failed++;
      console.error(`[stale-catalog] draft failed for ${p.sku}:`, err);
    }
    if (sleepMs > 0) await wait(sleepMs); // 2 req/sec
  }
  return { stale: stale.length, drafted, skipped, excluded, failed };
}

/** Run the stale-catalog draft against Turso + the live Shopify catalog. */
export async function runStaleCatalogDraft(maxAgeDays = STALE_DAYS): Promise<StaleCatalogResult> {
  const stale = await getStaleImportedProducts(maxAgeDays);
  if (stale.length === 0) return { stale: 0, drafted: 0, skipped: 0, excluded: 0, failed: 0 };

  // One paginated fetch for every product's current status — cheaper and gentler on the API
  // than a GET per stale product, and lets us skip ones already drafted (idempotent re-runs).
  // The same fetch already carries tags, so the `exclude-stale` opt-out is free.
  const live = await fetchAllShopifyProducts();
  const statusById = new Map(live.map((p) => [p.shopifyId, p.status]));
  const excludedIds = new Set(
    // Case-insensitive: it's a human-applied ops tag, so "Exclude-Stale" must protect too.
    live.filter((p) => p.tags.some((t) => t.toLowerCase() === EXCLUDE_TAG)).map((p) => p.shopifyId),
  );

  return computeStaleDrafts(stale, statusById, draftShopifyProduct, RATE_LIMIT_MS, excludedIds);
}
