/**
 * Publish-reconcile. The inverse of stale-catalog: it PUBLISHES to the Online Store the
 * products aosom-sync considers sellable + currently in the Aosom feed but that sit
 * unpublished, so they render publicly (and fire ViewContent/AddToCart, and enter the Meta
 * catalog).
 *
 * Why they exist: `createShopifyProduct` only auto-publishes at CREATION. Products imported
 * before beb00b4 (2026-06-07) were created as `draft` for manual review — those never
 * activated stay draft. And flipping an existing product draft→active does NOT publish it to
 * the Online Store; nothing in the codebase republishes an existing product. So legacy stock
 * accumulates as `draft` (untagged) or `active`-but-unpublished, invisible to customers.
 *
 * Candidate rule (per product, grouped by Shopify product id) — a product is published iff:
 *   ( status=active && NOT published_at )          →  action "publish"
 *   OR ( status=draft && NOT tag `auto-drafted` )  →  action "activate_publish" (status→active + publish)
 *   AND NOT tag `exclude-stale`                    (operator opt-out)
 *   AND >=1 variant sellable in TODAY's Aosom CSV  (stockBufferQty(csvQty) > 0)
 *
 * Excluded by construction: `auto-drafted` (aosom-sync drafted it on purpose — discontinued or
 * stale-catalog oversell guard), `exclude-stale` (operator opt-out), and anything not sellable
 * in the current feed (stale/phantom stock → no oversell re-introduced).
 *
 * `computePublishReconcile` is pure (dependency-injected, unit-tested). `runPublishReconcile`
 * wires Turso + a FRESH Aosom CSV + Shopify. It is DRY-RUN unless `{ apply: true }`, guards on
 * the SAME `assertFeedComplete` (FEED_MIN_COVERAGE 0.70) the intraday stock-check uses so a
 * truncated CSV can never mass-publish, and caps writes at PUBLISH_WRITE_CAP per run.
 */
import { stockBufferQty, hasAutoDraftedTag } from "./diff-engine";
import { EXCLUDE_TAG } from "./stale-catalog";
import { assertFeedComplete } from "./stock-reconcile";
import { getStockBaseline } from "./database";
import { fetchAosomCatalog } from "./csv-fetcher";
import { fetchProductPublishStates, publishShopifyProduct } from "./shopify-client";

/** Max Online-Store publishes per run — a mass-unpublish anomaly can't blow the budget or
 * flood the catalog in one shot; the overflow is reported as `deferred` and drained next run. */
export const PUBLISH_WRITE_CAP = 67;
/** Spacing between Shopify writes → 2 requests/second (matches stale-catalog / stock-check). */
export const RATE_LIMIT_MS = 500;

/** One imported catalog row (variant) with its Shopify product id. */
export interface PublishReconcileRow {
  sku: string;
  shopifyProductId: string;
}

/** Live publication state of one Shopify product. */
export interface ShopifyPublishState {
  status: "active" | "draft" | "archived";
  /** true when published to the Online Store (published_at set, not future). */
  published: boolean;
  tags: string[];
}

export interface PublishReconcileInput {
  /** imported catalog rows (shopify_product_id set) — the sku→product grouping. */
  baseline: PublishReconcileRow[];
  /** sku -> qty from TODAY's freshly-fetched Aosom CSV (the current feed). */
  csvQtyBySku: Map<string, number>;
  /** shopify product id -> its live publish state. Absent id = archived/deleted → skipped. */
  stateById: Map<string, ShopifyPublishState>;
  /** max publish actions to emit (rest deferred). Default PUBLISH_WRITE_CAP. */
  writeCap?: number;
}

export type PublishAction = "publish" | "activate_publish";

export interface PlannedPublish {
  shopifyProductId: string;
  /** the product's imported SKUs (all variants). */
  skus: string[];
  action: PublishAction;
}

export interface PublishPlan {
  actions: PlannedPublish[];
  counts: {
    /** products that matched all rules (pre-cap). */
    candidates: number;
    publish: number;
    activatePublish: number;
    /** candidates dropped by the write cap this run. */
    deferred: number;
    /** matched-but-excluded (operator `exclude-stale`). */
    skippedExcludeStale: number;
    /** draft carrying our `auto-drafted` marker — intentional, never republished here. */
    skippedAutoDrafted: number;
  };
}

interface Group {
  shopifyProductId: string;
  skus: string[];
}

/**
 * Pure planner. Groups imported rows by Shopify product id and decides which to publish,
 * using ONLY the current CSV (sellability) + live Shopify state (status/published/tags).
 * No I/O — the caller performs the writes. Deterministic (sorted by product id) so the write
 * cap always drops the same tail across re-runs.
 */
export function computePublishReconcile(input: PublishReconcileInput): PublishPlan {
  const writeCap = input.writeCap ?? PUBLISH_WRITE_CAP;

  const groups = new Map<string, Group>();
  for (const row of input.baseline) {
    if (!row.shopifyProductId) continue;
    let g = groups.get(row.shopifyProductId);
    if (!g) { g = { shopifyProductId: row.shopifyProductId, skus: [] }; groups.set(row.shopifyProductId, g); }
    g.skus.push(row.sku);
  }

  const matched: PlannedPublish[] = [];
  let skippedExcludeStale = 0;
  let skippedAutoDrafted = 0;

  for (const g of groups.values()) {
    const state = input.stateById.get(g.shopifyProductId);
    if (!state || state.status === "archived") continue; // deleted/archived — leave alone

    // Sellable in TODAY's feed? (buffered availability, same rule as the whole app). A product
    // not in the current CSV, or sold out, is skipped — never republish stale/phantom stock.
    const sellableInFeed = g.skus.some((sku) => {
      const q = input.csvQtyBySku.get(sku);
      return q != null && stockBufferQty(q) > 0;
    });
    if (!sellableInFeed) continue;

    // Operator opt-out wins over everything.
    if (state.tags.some((t) => t.toLowerCase() === EXCLUDE_TAG)) { skippedExcludeStale++; continue; }

    if (state.status === "active" && !state.published) {
      matched.push({ shopifyProductId: g.shopifyProductId, skus: g.skus, action: "publish" });
    } else if (state.status === "draft") {
      if (hasAutoDraftedTag(state.tags)) { skippedAutoDrafted++; continue; } // intentional aosom-sync draft
      matched.push({ shopifyProductId: g.shopifyProductId, skus: g.skus, action: "activate_publish" });
    }
    // status=active && published → already live (would already be in the catalog): no action.
  }

  matched.sort((a, b) => a.shopifyProductId.localeCompare(b.shopifyProductId));
  const actions = matched.slice(0, writeCap);
  const deferred = matched.length - actions.length;

  return {
    actions,
    counts: {
      candidates: matched.length,
      publish: actions.filter((a) => a.action === "publish").length,
      activatePublish: actions.filter((a) => a.action === "activate_publish").length,
      deferred,
      skippedExcludeStale,
      skippedAutoDrafted,
    },
  };
}

export interface PublishReconcileResult {
  dryRun: boolean;
  candidates: number;
  publish: number;
  activatePublish: number;
  deferred: number;
  skippedExcludeStale: number;
  skippedAutoDrafted: number;
  /** apply only: products successfully published. */
  published?: number;
  /** apply only: publish writes that failed (product left as-is). */
  failed?: number;
  /** dry-run only: the planned actions (for the operator to review before apply). */
  planned?: PlannedPublish[];
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run publish-reconcile against Turso + a FRESH Aosom CSV + the live Shopify catalog.
 * DRY-RUN by default (plans, writes nothing, returns `planned`). Pass `{ apply: true }` to
 * publish (rate-limited to 2 req/sec, capped at PUBLISH_WRITE_CAP). Aborts before ANY write —
 * via `assertFeedComplete` — if the fetched CSV is implausibly thin (truncated feed guard).
 */
export async function runPublishReconcile(opts: { apply?: boolean } = {}): Promise<PublishReconcileResult> {
  const csv = await fetchAosomCatalog();
  const csvQtyBySku = new Map<string, number>();
  for (const p of csv) csvQtyBySku.set(p.sku, p.qty);

  const baselineRows = await getStockBaseline();
  // Same truncated-feed guard as the intraday stock-check — bail before any write if the
  // fetched CSV covers < FEED_MIN_COVERAGE of imported SKUs.
  assertFeedComplete(csvQtyBySku, baselineRows);

  const states = await fetchProductPublishStates();
  const stateById = new Map<string, ShopifyPublishState>(
    states.map((s) => [s.shopifyId, { status: s.status, published: s.published, tags: s.tags }]),
  );

  const plan = computePublishReconcile({
    baseline: baselineRows.map((r) => ({ sku: r.sku, shopifyProductId: r.shopifyProductId })),
    csvQtyBySku,
    stateById,
    writeCap: PUBLISH_WRITE_CAP,
  });

  if (!opts.apply) {
    return { dryRun: true, ...plan.counts, planned: plan.actions };
  }

  let published = 0;
  let failed = 0;
  for (const action of plan.actions) {
    try {
      await publishShopifyProduct(action.shopifyProductId, { activate: action.action === "activate_publish" });
      published++;
    } catch (err) {
      failed++;
      console.error(`[publish-reconcile] publish failed for ${action.shopifyProductId} (${action.skus[0]}):`, err);
    }
    await wait(RATE_LIMIT_MS); // 2 req/sec
  }

  return { dryRun: false, ...plan.counts, published, failed };
}
