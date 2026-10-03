/**
 * Costway sell price + margin (Mat, 2026-10-03).
 *
 * Facts established by comparing the feed to the live costway.ca pages (36 articles):
 *  - the feed's `Variant Price` IS Costway's real selling price (equal on 83% of items, never lower
 *    than the site; the site is up to ~3% lower, only on items tagged "Drop Price" — a promotion the
 *    feed lags behind). Its "crossed-out" compare-at price is Costway's own marketing price.
 *  - our cost is that price minus the 16% dropship discount.
 *
 * Rules:
 *  - sell at the feed price (0% markup, like Aosom — see pricing.ts);
 *  - on a "Drop Price" item, undercut the lag: ×0.97, so we are never dearer than costway.ca;
 *  - NEVER below `Price Drop` (Costway's advertised-price floor), whatever the adjustment;
 *  - NEVER reuse Costway's crossed-out price as our compare-at (a 79%-off "original price" is
 *    Costway's claim, not ours).
 */

/** Dropship discount Costway gives us off its retail price. Override: COSTWAY_DROPSHIP_DISCOUNT. */
export function dropshipDiscount(): number {
  const v = Number(process.env.COSTWAY_DROPSHIP_DISCOUNT);
  return Number.isFinite(v) && v > 0 && v < 0.6 ? v : 0.16;
}

/** Applied to "Drop Price" items to land at or under the live site price. */
export const DROP_PRICE_ADJUSTMENT = 0.97;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a variant costs us: the feed (retail) price less the dropship discount. */
export function costOf(feedPrice: number): number {
  return round2(feedPrice * (1 - dropshipDiscount()));
}

export interface SellPriceInput {
  /** The feed's `Variant Price`. */
  price: number;
  /** The feed's `Price Drop` — Costway's advertised-price floor, or null. */
  priceDrop: number | null;
  promoTag: string | null;
}

/** The price we put on Shopify, or NaN for an unusable input (never push $0 / NaN). */
export function costwaySellPrice(i: SellPriceInput): number {
  if (!Number.isFinite(i.price) || i.price <= 0) return NaN;
  let p = i.promoTag === "Drop Price" ? i.price * DROP_PRICE_ADJUSTMENT : i.price;
  if (i.priceDrop != null && Number.isFinite(i.priceDrop) && i.priceDrop > 0) p = Math.max(p, i.priceDrop);
  return round2(p);
}

/** Gross margin ($ and % of the sell price) before payment fees and returns. */
export function marginOf(sellPrice: number, feedPrice: number): { dollars: number; pct: number } {
  const dollars = round2(sellPrice - costOf(feedPrice));
  return { dollars, pct: sellPrice > 0 ? Math.round((dollars / sellPrice) * 1000) / 10 : 0 };
}

/**
 * Stock we are willing to sell. Orders are placed by hand, so a unit that vanishes between the
 * customer's click and the manual order is a real cost: below `minQty` the variant is sold out, and
 * the Shopify quantity is capped so a 5,000-unit warehouse does not show as 5,000.
 */
export function sellableQty(costwayQty: number, minQty = 3, cap = 50): number {
  if (!Number.isFinite(costwayQty) || costwayQty < minQty) return 0;
  return Math.min(Math.floor(costwayQty), cap);
}
