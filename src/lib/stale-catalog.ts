/**
 * Stale-catalog cleanup. Imported products that haven't appeared in the Aosom CSV for >N days
 * but are still live on Shopify are likely discontinued at Aosom. This drafts them.
 *
 * Until 2026-09-14 the query behind this also required `qty > 0`, framing the job purely as
 * oversell protection. That excluded the clearest discontinued case of all — sold out AND gone
 * from the feed — and nothing else caught those either, so they piled up: 139 of the 179
 * feed-absent products still live in the Meta catalog were invisible here, while the cron kept
 * reporting a reassuring `stale=44`. Dropping the clause takes the 30-day candidate list from
 * 45 to 406, which is why WRITE_CAP now exists.
 *
 * The decision logic (`computeStaleDrafts`) is dependency-injected (a status map + a draft fn)
 * so it is unit-testable without network. `runStaleCatalogDraft()` wires it to Turso + Shopify.
 * Mirrors the one-shot scripts/fix-stale-products.mjs, made idempotent: a product already
 * draft/archived on Shopify is skipped, and one that's gone (deleted) counts as failed.
 */
import { getStaleImportedProducts } from "@/lib/database";
import { fetchAllShopifyProducts, updateShopifyProduct } from "@/lib/shopify-client";
import { addAutoDraftedTag } from "@/lib/diff-engine";

export const STALE_DAYS = 30;
/** Spacing between Shopify draft writes → 2 requests/second. */
export const RATE_LIMIT_MS = 500;
/**
 * Max Shopify draft writes per run. Bounds blast radius and keeps the run inside the cron's
 * 300s budget: at 500ms a write, 250 writes is ~2min, leaving room for the paginated
 * `fetchAllShopifyProducts`. Unbounded was fine while the candidate list was ~45 products; it
 * is not now that removing `qty > 0` made it 406, which would run ~3.4min of writes alone and
 * risk a SIGKILL mid-batch.
 *
 * Safe to cap because the pass is convergent and idempotent: candidates are ordered
 * `last_seen_at ASC` (longest-absent first), an already-drafted product is skipped on the next
 * run, and the cron fires daily. A capped run is simply drained by the following ones.
 */
export const WRITE_CAP = 250;
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
  /** Candidates left untouched because the per-run WRITE_CAP was reached; next run drains them. */
  deferred: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pure orchestration. For each stale product, decide what to do:
 * - in `excludedIds` (carries the `exclude-stale` tag) → leave live (operator opt-out)
 * - active   → draft it (rate-limited via `sleepMs`)
 * - draft/archived → skip
 * - absent from the map (deleted on Shopify) → failed
 * A thrown `draftFn` counts as failed and never aborts the batch.
 *
 * Only actual WRITES count against `writeCap` — a skip, an exclusion or a missing product costs
 * nothing, so a run whose candidates are mostly already-drafted still reaches the ones that need
 * work instead of burning the cap on no-ops.
 */
export async function computeStaleDrafts(
  stale: Array<{ sku: string; shopify_product_id: string }>,
  statusById: Map<string, string>,
  draftFn: (shopifyId: string) => Promise<void>,
  sleepMs: number = RATE_LIMIT_MS,
  excludedIds: Set<string> = new Set(),
  writeCap: number = WRITE_CAP,
): Promise<StaleCatalogResult> {
  let drafted = 0, skipped = 0, excluded = 0, failed = 0, deferred = 0;
  for (const p of stale) {
    if (excludedIds.has(p.shopify_product_id)) { excluded++; continue; } // operator opt-out
    const status = statusById.get(p.shopify_product_id);
    if (status === undefined) { failed++; continue; }   // deleted on Shopify (stale id in our DB)
    if (status !== "active") { skipped++; continue; }    // already draft/archived
    if (drafted >= writeCap) { deferred++; continue; }   // per-run cap — next run drains the rest
    try {
      await draftFn(p.shopify_product_id);
      drafted++;
    } catch (err) {
      failed++;
      console.error(`[stale-catalog] draft failed for ${p.sku}:`, err);
    }
    if (sleepMs > 0) await wait(sleepMs); // 2 req/sec
  }
  return { stale: stale.length, drafted, skipped, excluded, failed, deferred };
}

/** Run the stale-catalog draft against Turso + the live Shopify catalog. */
export async function runStaleCatalogDraft(maxAgeDays = STALE_DAYS): Promise<StaleCatalogResult> {
  const stale = await getStaleImportedProducts(maxAgeDays);
  if (stale.length === 0) return { stale: 0, drafted: 0, skipped: 0, excluded: 0, failed: 0, deferred: 0 };

  // One paginated fetch for every product's current status — cheaper and gentler on the API
  // than a GET per stale product, and lets us skip ones already drafted (idempotent re-runs).
  // The same fetch already carries tags, so the `exclude-stale` opt-out is free.
  const live = await fetchAllShopifyProducts();
  const statusById = new Map(live.map((p) => [p.shopifyId, p.status]));
  const tagsById = new Map(live.map((p) => [p.shopifyId, p.tags]));
  const excludedIds = new Set(
    // Case-insensitive: it's a human-applied ops tag, so "Exclude-Stale" must protect too.
    live.filter((p) => p.tags.some((t) => t.toLowerCase() === EXCLUDE_TAG)).map((p) => p.shopifyId),
  );

  // Draft AND stamp the `auto-drafted` marker so the intraday stock-check cron can later
  // reactivate ONLY the products WE auto-drafted (never a product an operator drafted by
  // hand) when they return to the feed with sellable stock. Without the marker, a
  // stale-catalog draft could never come back live. See stock-reconcile.planStockActions.
  const draftAndTag = (shopifyId: string) =>
    updateShopifyProduct(shopifyId, { status: "draft", tags: addAutoDraftedTag(tagsById.get(shopifyId) ?? []) });

  return computeStaleDrafts(stale, statusById, draftAndTag, RATE_LIMIT_MS, excludedIds);
}
