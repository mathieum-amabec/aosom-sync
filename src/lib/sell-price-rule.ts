/**
 * Sell-price rule (Mat, 2026-10-28): sell at the Aosom price. We may never display less than Aosom does, and since the
 * 2026-10-15 rise (≈ +6.5 % over Aosom on average) shoppers found the same items cheaper on aosom.ca / Amazon. Mat:
 * "j'aime mieux me faire moins de profit sur 15 ventes que plus de profit sur 1 vente".
 *
 * PURE: no I/O. `pricing.ts#targetSellPrice` stays the Aosom floor (the audit and the spike guard still rely on it).
 *
 * Rule:
 *   1. PRICE = the Aosom price (rounded to the cent, as Aosom publishes it).
 *   2. PROFIT FLOOR — with our cost known (wholesale + delivery), the price never goes under `profitFloor(cost)`: at list
 *      price, after the card fees, we still clear our cost by MIN_PROFIT_ON_COST. When the Aosom price is below that
 *      (Aosom raised its wholesale price), we stay just above Aosom instead of selling at a loss.
 *
 * Checkout discounts (10 % on the 2nd item, BIENVENUE20, the welcome wheel) are NOT covered by the floor any more
 * (Mat, 2026-10-28: the 2nd-item discount is a plus, the first item already earns our margin). MAX_DISCOUNT still caps
 * what a single discount may take, and the margin guard still flags discounts above it.
 *
 * The competitor price and the cost-based markup of the 2026-10-15 rule are no longer used: we cannot go below Aosom,
 * and ameublementarabais sits above it.
 */

/**
 * Biggest discount one item can get at checkout. On 2026-10-18 the store runs three discounts and none combines with
 * another: 10 % on the 2nd item, BIENVENUE20 (20 $ from 200 $, so at most 10 %), a 10 % one-customer discount. A new
 * discount above this, or discounts that combine, is flagged by margin-guard.ts.
 */
export const MAX_DISCOUNT = 0.1;
/** Discount the profit floor assumes: none (Mat, 2026-10-28 — a discounted 2nd item may earn less than our margin). */
export const FLOOR_DISCOUNT = 0;
/** Shopify Payments (Canada) card fee on what the customer pays: rate + fixed part. */
export const CARD_FEE_RATE = 0.029;
export const CARD_FEE_FIXED = 0.3;
/** What we must still earn over our cost at list price, after the card fees. */
export const MIN_PROFIT_ON_COST = 0.02;

/** Smallest price ending in .99 that is >= `p`. */
export function roundUpTo99(p: number): number {
  if (!Number.isFinite(p)) return p;
  let r = Math.floor(p) + 0.99;
  if (r < p - 1e-9) r += 1;
  return round2(r);
}

/**
 * Lowest price that stays profitable for a unit costing `cost`: after FLOOR_DISCOUNT and the card fees we still keep
 * cost × (1 + MIN_PROFIT_ON_COST). About cost × 1.05 + 0.31 $, ending in .99. NaN when the cost is unknown.
 */
export function profitFloor(cost: number | null | undefined): number {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return NaN;
  return roundUpTo99((cost * (1 + MIN_PROFIT_ON_COST) + CARD_FEE_FIXED) / ((1 - FLOOR_DISCOUNT) * (1 - CARD_FEE_RATE)));
}

/** What we keep on one unit sold at `price` with `discount` off and the card fees paid. */
export function netProfit(price: number, cost: number, discount = FLOOR_DISCOUNT): number {
  const paid = price * (1 - discount);
  return round2(paid - paid * CARD_FEE_RATE - CARD_FEE_FIXED - cost);
}

/** "competitor" | "cap" | "tier" | "margin" come from the 2026-10-15 rule and survive only in price history rows. */
export type SellPriceReason = "competitor" | "cap" | "tier" | "margin" | "floor" | "profit";

export interface SellPriceInput {
  aosomPrice: number;
  productType?: string;
  /** Ignored since 2026-10-28 (kept so callers need not change). */
  competitorPrice?: number | null;
  /** Our unit cost (wholesale price + delivery fee), when known. */
  cost?: number | null;
}

export interface SellPriceResult {
  price: number;
  reason: SellPriceReason;
  /** Always false since 2026-10-28: no competitor price is used. */
  competitorIgnored: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Largest price ending in .99 that is <= `p` (p >= 0.99). */
export function roundDownTo99(p: number): number {
  if (!Number.isFinite(p) || p < 0.99) return round2(p);
  return round2(Math.floor(p - 0.99 + 1e-9) + 0.99);
}

export function computeSellPrice(input: SellPriceInput): SellPriceResult {
  const { aosomPrice, cost } = input;
  if (!Number.isFinite(aosomPrice) || aosomPrice <= 0) return { price: NaN, reason: "floor", competitorIgnored: false };
  return withProfitFloor({ price: round2(aosomPrice), reason: "floor", competitorIgnored: false }, cost);
}

/** Raises a price to `profitFloor(cost)` when it sits below it (reason "profit"). Unknown cost: unchanged. */
export function withProfitFloor(res: SellPriceResult, cost: number | null | undefined): SellPriceResult {
  const min = profitFloor(cost);
  if (!Number.isFinite(res.price) || !Number.isFinite(min) || res.price >= min - 0.005) return res;
  return { ...res, price: min, reason: "profit" };
}
