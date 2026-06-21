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

export interface StaleCatalogResult {
  /** Stale candidates found in the catalog. */
  stale: number;
  /** Newly drafted on Shopify this run. */
  drafted: number;
  /** Already draft/archived on Shopify — left alone. */
  skipped: number;
  /** Draft write failed, or the product no longer exists on Shopify. */
  failed: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure orchestration. For each stale product, look up its live Shopify status:
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
): Promise<StaleCatalogResult> {
  let drafted = 0, skipped = 0, failed = 0;
  for (const p of stale) {
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
  return { stale: stale.length, drafted, skipped, failed };
}

/** Run the stale-catalog draft against Turso + the live Shopify catalog. */
export async function runStaleCatalogDraft(maxAgeDays = STALE_DAYS): Promise<StaleCatalogResult> {
  const stale = await getStaleImportedProducts(maxAgeDays);
  if (stale.length === 0) return { stale: 0, drafted: 0, skipped: 0, failed: 0 };

  // One paginated fetch for every product's current status — cheaper and gentler on the API
  // than a GET per stale product, and lets us skip ones already drafted (idempotent re-runs).
  const live = await fetchAllShopifyProducts();
  const statusById = new Map(live.map((p) => [p.shopifyId, p.status]));

  return computeStaleDrafts(stale, statusById, draftShopifyProduct);
}
