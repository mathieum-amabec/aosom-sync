/**
 * Sell-price rule (Mat, 2026-11-09): sell at our ESTIMATE of Aosom's current retail price, ending in .88 (our signature).
 *
 * Since 2026-10-15 the Aosom feed carries no public price, only our cost (`2B Product Price` + `shiping_fee`). The last
 * known public price (products.price) is frozen at mid-October, and Aosom has raised its costs since: on 2026-11-09 an
 * order sold at the frozen price lost money. Eight real aosom.ca prices that day sat at 1.07–1.19 × our cost (median
 * 1.15, the same median as frozen public price / today's cost over 7,935 feed SKUs), so Aosom's retail ≈ cost × 1.15.
 *
 * PURE: no I/O. `pricing.ts#targetSellPrice` stays the frozen Aosom floor (the audit and the spike guard rely on it).
 *
 * Rule, when our cost is known:
 *   1. ESTIMATE = cost × AOSOM_RETAIL_MULTIPLIER, ending in .88. When that lands just over a round number (a ten under
 *      100 $, a hundred above), it drops to the .88 below it (301.88 → 299.88): the first digit is what shoppers read.
 *   2. FLOOR — never below the last known Aosom public price (shown as its .88 at or above it, unless that .88 would
 *      cross a round number: 299.99 stays 299.99).
 *   3. PROFIT FLOOR — never below `profitFloor(cost)` (cost + 2 % after card fees, ending in .88).
 * Cost unknown: the last known Aosom price, unchanged.
 *
 * Checkout discounts (10 % on the 2nd item, BIENVENUE20, the welcome wheel) are not covered by the floor; MAX_DISCOUNT
 * still caps what a single discount may take and the margin guard flags discounts above it.
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
/** Aosom's retail price ≈ our cost (wholesale + delivery) × this (measured 2026-11-09, see header). */
export const AOSOM_RETAIL_MULTIPLIER = 1.15;
/** Our signature price ending. */
export const PRICE_ENDING = 0.88;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const cents = (p: number): number => Math.round((p - Math.floor(p)) * 100);

/** Smallest price ending in .99 that is >= `p`. */
export function roundUpTo99(p: number): number {
  if (!Number.isFinite(p)) return p;
  let r = Math.floor(p) + 0.99;
  if (r < p - 1e-9) r += 1;
  return round2(r);
}

/** Largest price ending in .99 that is <= `p` (p >= 0.99). */
export function roundDownTo99(p: number): number {
  if (!Number.isFinite(p) || p < 0.99) return round2(p);
  return round2(Math.floor(p - 0.99 + 1e-9) + 0.99);
}

/** Smallest price ending in .88 that is >= `p`. */
export function roundUpTo88(p: number): number {
  if (!Number.isFinite(p)) return p;
  let r = Math.floor(p) + PRICE_ENDING;
  if (r < p - 1e-9) r += 1;
  return round2(r);
}

/** Largest price ending in .88 that is <= `p` (p >= 0.88). */
export function roundDownTo88(p: number): number {
  if (!Number.isFinite(p) || p < PRICE_ENDING) return round2(p);
  return round2(Math.floor(p - PRICE_ENDING + 1e-9) + PRICE_ENDING);
}

/** True when the price already carries our .88 ending. */
export function hasSignatureEnding(p: number | null | undefined): boolean {
  return typeof p === "number" && Number.isFinite(p) && cents(p) === Math.round(PRICE_ENDING * 100);
}

/**
 * A target price as our signature: the .88 nearest at or under `t + 0.88`, i.e. `floor(t) + .88`. When that sits just
 * over a round number (a ten under 100 $, a hundred from 100 $; "just over" = within max(1 $, 3 %)), it drops to the
 * .88 under that round number: 301.88 → 299.88, 60.88 → 59.88.
 */
export function signaturePrice(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return NaN;
  const p = round2(Math.floor(t) + PRICE_ENDING);
  const step = roundStep(p);
  const base = Math.floor(p / step) * step;
  const over = p - base;
  if (base > 0 && over < Math.max(1, p * 0.03)) return round2(base - 1 + PRICE_ENDING);
  return p;
}

/** The round-number step a price is read against: tens under 100 $, hundreds from 100 $. */
function roundStep(p: number): number {
  return p < 100 ? 10 : 100;
}

/**
 * The frozen Aosom price as a floor, in our .88 when that does not cross a round number (63.99 → 64.88), else as it is
 * (299.99 stays 299.99 rather than 300.88).
 */
export function floorPrice(aosomPrice: number): number {
  if (!Number.isFinite(aosomPrice) || aosomPrice <= 0) return NaN;
  const up = roundUpTo88(aosomPrice);
  const step = roundStep(aosomPrice);
  return Math.floor(up / step) === Math.floor(aosomPrice / step) ? up : round2(aosomPrice);
}

/** Our estimate of Aosom's current retail price for a unit costing `cost`, as a signature price. NaN when unknown. */
export function estimatedAosomPrice(cost: number | null | undefined): number {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return NaN;
  return signaturePrice(cost * AOSOM_RETAIL_MULTIPLIER);
}

/**
 * Lowest price that stays profitable for a unit costing `cost`: after FLOOR_DISCOUNT and the card fees we still keep
 * cost × (1 + MIN_PROFIT_ON_COST). About cost × 1.05 + 0.31 $, ending in .88. NaN when the cost is unknown.
 */
export function profitFloor(cost: number | null | undefined): number {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return NaN;
  return roundUpTo88((cost * (1 + MIN_PROFIT_ON_COST) + CARD_FEE_FIXED) / ((1 - FLOOR_DISCOUNT) * (1 - CARD_FEE_RATE)));
}

/** What we keep on one unit sold at `price` with `discount` off and the card fees paid. */
export function netProfit(price: number, cost: number, discount = FLOOR_DISCOUNT): number {
  const paid = price * (1 - discount);
  return round2(paid - paid * CARD_FEE_RATE - CARD_FEE_FIXED - cost);
}

/**
 * "estimate" = our estimate of Aosom's price; "floor" = the frozen Aosom price; "profit" = the profit floor.
 * "competitor" | "cap" | "tier" | "margin" come from older rules and survive only in price history rows.
 */
export type SellPriceReason = "competitor" | "cap" | "tier" | "margin" | "floor" | "profit" | "estimate";

export interface SellPriceInput {
  /** The last known Aosom public price (frozen since 2026-10-15). */
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

export function computeSellPrice(input: SellPriceInput): SellPriceResult {
  const { aosomPrice, cost } = input;
  if (!Number.isFinite(aosomPrice) || aosomPrice <= 0) return { price: NaN, reason: "floor", competitorIgnored: false };
  const estimate = estimatedAosomPrice(cost);
  // Cost unknown: the frozen Aosom price, as it is.
  if (!Number.isFinite(estimate)) return { price: round2(aosomPrice), reason: "floor", competitorIgnored: false };
  const floor = floorPrice(aosomPrice);
  const res: SellPriceResult = estimate >= floor
    ? { price: estimate, reason: "estimate", competitorIgnored: false }
    : { price: floor, reason: "floor", competitorIgnored: false };
  return withProfitFloor(res, cost);
}

/** Raises a price to `profitFloor(cost)` when it sits below it (reason "profit"). Unknown cost: unchanged. */
export function withProfitFloor(res: SellPriceResult, cost: number | null | undefined): SellPriceResult {
  const min = profitFloor(cost);
  if (!Number.isFinite(res.price) || !Number.isFinite(min) || res.price >= min - 0.005) return res;
  return { ...res, price: min, reason: "profit" };
}
