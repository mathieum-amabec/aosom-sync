/**
 * Sell-price rule (Mat, 2026-10-14): raise prices slightly, never below Aosom, and stay a little cheaper than
 * the competitor wherever we can see their price.
 *
 * PURE: no I/O. `pricing.ts#targetSellPrice` stays the Aosom floor (the audit and the spike guard still rely on it);
 * this module decides how far ABOVE the floor a product may sit.
 *
 * Rule, in order:
 *   1. FLOOR  — never below the Aosom price (Mat's agreement with Aosom: we cannot display lower than they do).
 *   2. With a trustworthy competitor price: candidate = competitor − UNDERCUT_DOLLARS, capped at Aosom × (1 + MAX_MARKUP).
 *      We always stay below the competitor; when that leaves less than TARGET_MARGIN, the competitor wins (the margin
 *      is "about" 20 %, Mat 2026-10-15).
 *   3. Without one, and with our cost known (wholesale + delivery, feed of 2026-10-15): the price giving TARGET_MARGIN on
 *      cost, at least the tiered markup, capped at Aosom × (1 + MAX_MARKUP) (outdoor: OUTDOOR_MAX_MARKUP).
 *   4. Cost unknown: a tiered markup (small items carry more, big tickets and patio carry none).
 *   5. Prices end in .99 (rounded DOWN, so the result never exceeds the candidate), and are floored at Aosom again.
 *
 * A competitor SKU match is only trusted when their price is within a plausible band of Aosom's: a far-off price is a
 * different pack size or a bad scrape, and following it would put us far above (or below) a sane price.
 */

export const MAX_MARKUP = 0.15;
export const UNDERCUT_DOLLARS = 1;
/** Margin on cost-based price we aim for when no competitor price limits us (Mat, 2026-10-15: about 20 %). */
export const TARGET_MARGIN = 0.2;
/** Outdoor / patio is compared the most and is off-season: it may rise less. */
export const OUTDOOR_MAX_MARKUP = 0.07;
/** A competitor price outside [Aosom × LOW, Aosom × HIGH] is ignored (different pack, wrong match, bad scrape). */
export const COMPETITOR_PLAUSIBLE_LOW = 0.5;
export const COMPETITOR_PLAUSIBLE_HIGH = 1.6;

/** Tiered markup used when no competitor price is available. Upper bound exclusive. */
export const TIERS: ReadonlyArray<{ below: number; markup: number }> = [
  { below: 100, markup: 0.07 },
  { below: 200, markup: 0.07 },
  { below: 400, markup: 0.06 },
  { below: 800, markup: 0.05 },
  { below: Infinity, markup: 0.03 },
];

/** Patio / outdoor carry no markup (seasonal and compared the most). Matches Aosom product_type text. */
const NO_MARKUP_TYPE = /outdoor|patio|garden/i;

export type SellPriceReason = "competitor" | "cap" | "tier" | "margin" | "floor";

export interface SellPriceInput {
  aosomPrice: number;
  productType?: string;
  /** The competitor's current price for the same SKU, when known. */
  competitorPrice?: number | null;
  /** Our unit cost (wholesale price + delivery fee), when known. */
  cost?: number | null;
}

export interface SellPriceResult {
  price: number;
  reason: SellPriceReason;
  /** True when the competitor price was ignored as implausible. */
  competitorIgnored: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Largest price ending in .99 that is <= `p` (p >= 0.99). */
export function roundDownTo99(p: number): number {
  if (!Number.isFinite(p) || p < 0.99) return round2(p);
  return round2(Math.floor(p - 0.99 + 1e-9) + 0.99);
}

export function tierMarkup(aosomPrice: number, productType?: string): number {
  if (productType && NO_MARKUP_TYPE.test(productType)) return 0;
  for (const t of TIERS) if (aosomPrice < t.below) return t.markup;
  return 0;
}

export function computeSellPrice(input: SellPriceInput): SellPriceResult {
  const { aosomPrice, productType, competitorPrice, cost } = input;
  if (!Number.isFinite(aosomPrice) || aosomPrice <= 0) return { price: NaN, reason: "floor", competitorIgnored: false };
  const floor = round2(aosomPrice);

  const hasCompetitor = typeof competitorPrice === "number" && Number.isFinite(competitorPrice) && competitorPrice > 0;
  const plausible =
    hasCompetitor &&
    (competitorPrice as number) >= aosomPrice * COMPETITOR_PLAUSIBLE_LOW &&
    (competitorPrice as number) <= aosomPrice * COMPETITOR_PLAUSIBLE_HIGH;
  const competitorIgnored = hasCompetitor && !plausible;

  let candidate: number;
  let reason: SellPriceReason;
  if (plausible) {
    const undercut = (competitorPrice as number) - UNDERCUT_DOLLARS;
    const cap = aosomPrice * (1 + MAX_MARKUP);
    candidate = Math.min(undercut, cap);
    reason = undercut <= cap ? "competitor" : "cap";
  } else {
    const tierCandidate = aosomPrice * (1 + tierMarkup(aosomPrice, productType));
    if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
      const outdoor = !!productType && NO_MARKUP_TYPE.test(productType);
      const marginCandidate = cost / (1 - TARGET_MARGIN);
      const cap = aosomPrice * (1 + (outdoor ? OUTDOOR_MAX_MARKUP : MAX_MARKUP));
      candidate = Math.min(Math.max(tierCandidate, marginCandidate), cap);
      reason = marginCandidate > tierCandidate ? "margin" : "tier";
    } else {
      candidate = tierCandidate;
      reason = "tier";
    }
  }

  const rounded = roundDownTo99(candidate);
  if (rounded <= floor) return { price: floor, reason: "floor", competitorIgnored };
  return { price: rounded, reason, competitorIgnored };
}
