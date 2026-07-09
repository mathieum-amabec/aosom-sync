// Pure planning core for the intraday stock-check cron (/api/cron/stock-check).
//
// Given today's Aosom CSV quantities, the locally-stored baseline (last-seen qty +
// last_seen_at per SKU, with its Shopify product id), it decides — with NO I/O — which
// products changed availability and what to do. All Shopify reads/writes, the waitlist
// notify, and the baseline write live in the route; this module is fully unit-testable.
//
// Availability uses the SAME buffered threshold as the daily sync (stockBufferQty:
// qty<=10 -> sold out, else qty-3), so the two never disagree. Availability is product-level:
// a product is in stock if ANY of its variants is sellable.
import { stockBufferQty } from "./diff-engine";

/** One catalog row (variant) of an imported product, from the local `products` table. */
export interface StockBaselineRow {
  sku: string;
  /** last-stored Aosom qty — the baseline we diff today's CSV against. */
  qty: number;
  /** non-null Shopify product id (callers pass only imported rows). */
  shopifyProductId: string;
  /** last_seen_at epoch seconds — when this SKU was last present in the feed. */
  lastSeenAt: number;
}

export interface StockReconcileInput {
  /** sku -> qty from today's freshly-fetched CSV. A SKU absent from the map is absent from the feed. */
  csvQtyBySku: Map<string, number>;
  /** imported catalog rows (shopify_product_id IS NOT NULL). */
  baseline: StockBaselineRow[];
  /** now, epoch seconds. */
  nowEpoch: number;
  /** a product absent from the feed this long (and sold out) is treated as discontinued. Default 7. */
  staleDays?: number;
  /**
   * Shopify product ids currently DRAFT and carrying our `auto-drafted` marker (and NOT
   * `exclude-stale`) — the only products eligible for reactivation. Supplied by the route
   * from a Shopify status=draft fetch; absent/empty means no reactivation this run. Gating
   * on this set guarantees we never resurrect a product an operator drafted by hand.
   */
  autoDraftedIds?: Set<string>;
}

export type StockAction = "oos" | "restock" | "draft" | "reactivate";

export interface PlannedAction {
  shopifyProductId: string;
  /** the product's SKUs (all variants). */
  skus: string[];
  action: StockAction;
  /** target buffered availability: restock -> true, oos/draft -> false. */
  targetInStock: boolean;
  /** for `restock`: the variant SKUs that became sellable — fed to the back-in-stock waitlist. */
  restockSkus: string[];
}

export interface StockPlan {
  actions: PlannedAction[];
  /** CSV-present SKUs of flipped products to write back as the new baseline qty (keeps the
   * next run diffing from the current state). Drafted (absent) products contribute nothing. */
  qtyUpdates: Array<{ sku: string; qty: number }>;
  counts: { products: number; wentOOS: number; restocked: number; drafted: number; reactivated: number };
}

interface Group {
  shopifyProductId: string;
  rows: StockBaselineRow[];
}

/** Minimum fraction of imported SKUs the fetched feed must cover before we trust it.
 * 0.70 (was 0.80): the live Aosom feed dips to ~79.9% on truncated days (the 2026-07-08
 * stock-check false-aborted at 996/1247). 70% still blocks a genuinely broken/half-downloaded
 * CSV from mass-flipping the catalog, but stops skipping the intraday reconcile on normal wobble. */
export const FEED_MIN_COVERAGE = 0.7;

/**
 * Feed-completeness guard. A truncated / garbage CSV must never be allowed to mass-flip the
 * catalog (every missing SKU would otherwise look "gone from the feed" → discontinued sweep).
 * Throws — with NO plan produced — when the fetched feed covers fewer than `minCoverage` of the
 * imported SKUs. Called by the route before `planStockActions`; the daily sync keeps a complete
 * feed at ~100% coverage, so normal product churn (a handful discontinued) never trips this.
 */
export function assertFeedComplete(
  csvQtyBySku: Map<string, number>,
  baseline: StockBaselineRow[],
  minCoverage = FEED_MIN_COVERAGE,
): void {
  if (baseline.length === 0) return;
  const covered = baseline.reduce((n, r) => (csvQtyBySku.has(r.sku) ? n + 1 : n), 0);
  if (covered < minCoverage * baseline.length) {
    throw new Error(
      `Aosom feed covers ${covered}/${baseline.length} imported SKUs ` +
        `(< ${Math.round(minCoverage * 100)}%) — feed looks truncated, aborting before any write`,
    );
  }
}

/** True if any variant is sellable given today's CSV quantities (absent variant => not sellable). */
function anySellableFromCsv(rows: StockBaselineRow[], csv: Map<string, number>): boolean {
  return rows.some((r) => {
    const q = csv.get(r.sku);
    return q != null && stockBufferQty(q) > 0;
  });
}

/**
 * Plan stock-state transitions. Pure — returns the actions; the caller performs I/O.
 *
 * Per product (grouped by Shopify product id):
 *  - Present in feed:
 *      in -> out  => `oos`     (tag out-of-stock, stay active)
 *      out -> in  => `restock` (tag back-in-stock; caller reactivates iff auto-drafted)
 *      sellable + in `autoDraftedIds` (baseline never flipped) => `reactivate`
 *        (drafted-while-gone → returned to the feed; caller publishes iff still draft +
 *         auto-drafted + not exclude-stale)
 *  - Absent from feed AND sold out everywhere in the baseline AND last seen > staleDays ago:
 *      => `draft`  (discontinued; caller drafts only if still active)
 *  - Everything else: no action (convergent — safe to re-run).
 */
export function planStockActions(input: StockReconcileInput): StockPlan {
  const staleDays = input.staleDays ?? 7;
  const staleCutoff = input.nowEpoch - staleDays * 86400;

  const groups = new Map<string, Group>();
  for (const row of input.baseline) {
    if (!row.shopifyProductId) continue;
    let g = groups.get(row.shopifyProductId);
    if (!g) { g = { shopifyProductId: row.shopifyProductId, rows: [] }; groups.set(row.shopifyProductId, g); }
    g.rows.push(row);
  }

  const actions: PlannedAction[] = [];
  const qtyUpdates: Array<{ sku: string; qty: number }> = [];
  let wentOOS = 0, restocked = 0, drafted = 0, reactivated = 0;

  for (const g of groups.values()) {
    const skus = g.rows.map((r) => r.sku);
    const presentInFeed = g.rows.some((r) => input.csvQtyBySku.has(r.sku));
    const prevInStock = g.rows.some((r) => stockBufferQty(r.qty) > 0);

    if (presentInFeed) {
      const newInStock = anySellableFromCsv(g.rows, input.csvQtyBySku);
      let didReactivate = false;
      if (prevInStock && !newInStock) {
        actions.push({ shopifyProductId: g.shopifyProductId, skus, action: "oos", targetInStock: false, restockSkus: [] });
        wentOOS++;
      } else if (!prevInStock && newInStock) {
        // Sold-out → sellable. The route reactivates iff the product is draft + auto-drafted.
        const restockSkus = g.rows
          .filter((r) => { const q = input.csvQtyBySku.get(r.sku); return q != null && stockBufferQty(q) > 0; })
          .map((r) => r.sku);
        actions.push({ shopifyProductId: g.shopifyProductId, skus, action: "restock", targetInStock: true, restockSkus });
        restocked++;
      } else if (newInStock && input.autoDraftedIds?.has(g.shopifyProductId)) {
        // Sellable AND one of OUR auto-drafted products, but the baseline never went sold-out
        // (a stale-catalog draft freezes qty > 0), so the restock branch above never fires.
        // This is the reactivation net for "drafted while gone → returned to the feed". The
        // route re-checks draft + auto-drafted + not exclude-stale before publishing.
        actions.push({ shopifyProductId: g.shopifyProductId, skus, action: "reactivate", targetInStock: true, restockSkus: [] });
        reactivated++;
        didReactivate = true;
      }
      // Refresh baseline for every CSV-present variant of a flipped OR reactivated product
      // (only these write, so a stable product never churns the DB). Reactivation un-freezes
      // the stale qty that kept the product looking "in stock" while it sat drafted.
      if (prevInStock !== newInStock || didReactivate) {
        for (const r of g.rows) {
          const q = input.csvQtyBySku.get(r.sku);
          if (q != null) qtyUpdates.push({ sku: r.sku, qty: q });
        }
      }
    } else {
      // Absent from the feed. Draft only the discontinued ones: sold out in the baseline AND
      // not seen for > staleDays. (A product that vanished while in stock is left active.)
      const allSoldOut = g.rows.every((r) => stockBufferQty(r.qty) === 0);
      const lastSeen = g.rows.reduce((mx, r) => Math.max(mx, r.lastSeenAt), 0);
      if (allSoldOut && lastSeen < staleCutoff) {
        actions.push({ shopifyProductId: g.shopifyProductId, skus, action: "draft", targetInStock: false, restockSkus: [] });
        drafted++;
      }
    }
  }

  return { actions, qtyUpdates, counts: { products: groups.size, wentOOS, restocked, drafted, reactivated } };
}
