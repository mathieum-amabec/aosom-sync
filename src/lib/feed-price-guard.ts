import type { AosomProduct } from "@/types/aosom";

/**
 * The Aosom feed's public price column (`Price`) was replaced by `2B Product Price` — the wholesale (B2B) cost, ~25-40 %
 * lower than the price Aosom publishes — on 2026-10-15. Read as `Price`, every row came back as 0, and the 06:00 sync
 * wrote 0 over every stored price (and logged 8,017 fake "price drop" rows). The wholesale price must NEVER stand in for
 * the public price: our rule is never to display below what Aosom publishes.
 *
 * Until the feed carries the public price again, a row with no usable price keeps the last price we knew.
 */
export interface PriceCarryResult {
  products: AosomProduct[];
  /** Rows with no price in the feed that took the last known price. */
  carried: number;
  /** Rows with no price in the feed and nothing known: left at 0 (never imported, never priced). */
  unknown: number;
  /** Share of the feed with no usable price (0..1). */
  missingShare: number;
}

/** A feed where at least this share of the rows has no price is treated as having lost its price column. */
export const PRICE_COLUMN_LOST_SHARE = 0.5;

export function carryForwardMissingPrices(
  products: readonly AosomProduct[],
  snapshot: ReadonlyMap<string, { price: number }>,
): PriceCarryResult {
  let carried = 0;
  let unknown = 0;
  const out = products.map((p) => {
    if (Number.isFinite(p.price) && p.price > 0) return p;
    const known = snapshot.get(p.sku)?.price;
    if (known != null && Number.isFinite(known) && known > 0) {
      carried++;
      return { ...p, price: known };
    }
    unknown++;
    return p;
  });
  const missing = carried + unknown;
  return { products: out, carried, unknown, missingShare: products.length === 0 ? 0 : missing / products.length };
}

/** Parse a feed price such as "41.36", "41.36 CAD" or "$1,299.00"; 0 when there is no number. */
export function parseFeedPrice(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (typeof raw !== "string") return 0;
  const cleaned = raw.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  const n = cleaned ? parseFloat(cleaned[0]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
