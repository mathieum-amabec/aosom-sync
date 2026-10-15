/**
 * Single source of truth for the Shopify sell price given a product's Aosom CSV price.
 *
 * Pricing rule (Mat, 2026-06):
 * - Sell at exactly the Aosom CSV price — **0% markup** — to stay price-competitive
 *   with Aosom itself.
 * - NEVER sell below the Aosom CSV price. The Aosom price is the **absolute floor**.
 *   Our real cost is ≈ `aosomPrice × 0.82` (18% Aosom supplier discount), so selling
 *   at the Aosom price preserves a ~18% gross margin; dropping below it erodes or
 *   erases that margin.
 *
 * Both write paths use this: the sync diff (`diff-engine.ts`) and the import
 * (`createShopifyProduct`). If a markup is ever introduced, change `MARKUP` here and
 * the `Math.max` floor still guarantees the result can never fall below the Aosom price.
 *
 * Invalid input (missing/garbage CSV price → `0`/NaN) returns `NaN`, NOT `0`: a $0
 * price must never be pushed to the live store. Callers MUST treat a non-finite
 * result as "no valid price" and skip the change.
 */

/** Markup over the Aosom CSV price. 0 = sell at the Aosom price (current policy). */
export const PRICE_MARKUP = 0;

/**
 * The target Shopify sell price for a given Aosom CSV price. For a valid positive
 * input it is always `>= aosomPrice` (the floor), so a below-floor price can never be
 * produced. For a non-positive / non-finite input it returns `NaN` (no valid price) —
 * callers must skip rather than push $0.
 */
export function targetSellPrice(aosomPrice: number): number {
  if (!Number.isFinite(aosomPrice) || aosomPrice <= 0) return NaN;
  const desired = aosomPrice * (1 + PRICE_MARKUP);
  // Floor: never below the Aosom CSV price, whatever the markup.
  return Math.max(desired, aosomPrice);
}

/** A stored sell price above this multiple of the Aosom price is treated as corrupt and ignored. */
const STORED_SELL_PRICE_MAX_RATIO = 1.5;

/**
 * The price a product should sell at right now: the stored sell price (see sell-price-sync.ts) when it is sane, else
 * the Aosom floor. Sane = at or above the floor (Aosom may have raised its price since the sell price was stored) and
 * at most 1.5x the Aosom price (guards against a corrupt value). With the pricing mode off nothing is stored, so this
 * returns `targetSellPrice(aosomPrice)` — today's behaviour. `NaN` for an invalid Aosom price.
 */
export function effectiveSellPrice(aosomPrice: number, stored?: number | null): number {
  const floor = targetSellPrice(aosomPrice);
  if (!Number.isFinite(floor)) return NaN;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= floor - 0.005 && stored <= floor * STORED_SELL_PRICE_MAX_RATIO) {
    return Math.round(Math.max(stored, floor) * 100) / 100;
  }
  return floor;
}

/** True when `shopifyPrice` is below the Aosom floor (beyond a 1-cent tolerance). */
export function isBelowFloor(shopifyPrice: number, aosomPrice: number): boolean {
  return shopifyPrice < aosomPrice - 0.01;
}
