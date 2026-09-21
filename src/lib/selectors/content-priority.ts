/**
 * Content priority — trend + season scoring for the demand-gen/avant-après/assembly
 * batch pipelines (Étape 2 of the content-scale chantier).
 *
 * THIS IS NEW CODE, not a reuse of a pre-existing "trend score". Two things the task
 * assumed already existed turned out not to, on inspection of the actual schema:
 *   - There is no combined "velocity 60% + discount% 40%" trend score anywhere in the
 *     codebase. `getTrendingProducts`/`bestSellers` in database.ts rank by pure stock
 *     velocity only (no discount term at all).
 *   - `products` has no `compare_at_price` column — only `has_discount` (0/1, a flag,
 *     not a percentage). `by-category.ts`'s `discount` sort branch references
 *     `compare_at_price` and would throw `no such column` if ever exercised against the
 *     real schema (verified directly against Turso — an existing, unrelated bug, flagged
 *     separately, not touched here). So "rabais%" is approximated here as the binary
 *     `has_discount` flag weighted at 40%, not a graduated percentage — a real percentage
 *     would need a live Shopify `compare_at_price` lookup per candidate, out of scope for
 *     this pass.
 *   - `selectors/seasonal.ts`'s `SEASONAL_THEMES` map (`"Indoor Furniture"`, `"Heating"`,
 *     `"Christmas"`, …) does not match the real `product_type` taxonomy at all — every one
 *     of those literal category names returns ZERO rows on an exact match (verified). It
 *     is not reused here; the season filter below is built from product_type prefixes and
 *     keywords confirmed against real data instead.
 *
 * Velocity reuses the exact `price_history` stock-depletion query `bestSellers`/
 * `getTrendingProducts` already use (SUM(old_qty - new_qty) over a 14-day window where
 * stock went down) — only the combination with discount + season is new.
 */
import { getSelectorDb } from "./db";

export interface PriorityCandidate {
  sku: string;
  productType: string | null;
  velocity14d: number;
  hasDiscount: boolean;
}

export interface ScoredCandidate extends PriorityCandidate {
  /** 0..1, velocity-only component (min-max normalized within this candidate set). */
  velocityScore: number;
  /** 0 or 1 — has_discount is a flag, not a graduated percentage (see module header). */
  discountScore: number;
  /** velocityScore*0.6 + discountScore*0.4, before the seasonal multiplier. */
  trendScore: number;
  /** 1.2 = confirmed indoor/fall-winter category, 1.0 = neutral, excluded rows never appear here. */
  seasonalMultiplier: "indoor" | "seasonal-keyword" | "neutral";
  /** trendScore * seasonalMultiplier — sort by this, descending. */
  priority: number;
}

const VELOCITY_WEIGHT = 0.6;
const DISCOUNT_WEIGHT = 0.4;
const INDOOR_BOOST = 1.2;
const SEASONAL_KEYWORD_BOOST = 1.15;

/**
 * product_type prefixes/keywords confirmed to actually match rows in this catalogue
 * (checked via direct query, 2026-09-20) — NOT the seasonal.ts map, which doesn't.
 * "Automne/hiver actuel" per the task: indoor furniture in, patio/summer-outdoor out.
 */
const INDOOR_PREFIX = "Home Furnishings%";
const PATIO_PREFIX = "Patio & Garden%";
const SEASONAL_KEYWORDS = ["%Storage%", "%Christmas%", "%Holiday%", "%Fireplace%"];

/**
 * Fetch velocity + discount-flag + product_type for every SKU matching `poolWhere`
 * (a caller-supplied WHERE fragment identifying the format's candidate pool — e.g. "has a
 * raw Aosom video", "has a CA/US UGC clip"), excluding Patio & Garden outright per the
 * task's explicit "pas de patio/extérieur d'été" instruction.
 */
export async function fetchPriorityCandidates(
  poolWhereSql: string,
  poolArgs: (string | number)[] = [],
): Promise<PriorityCandidate[]> {
  const db = await getSelectorDb();
  const result = await db.execute({
    sql: `
      SELECT p.sku, p.product_type,
             COALESCE(v.velocity14d, 0) AS velocity14d,
             COALESCE(p.has_discount, 0) AS has_discount
      FROM products p
      LEFT JOIN (
        SELECT sku, SUM(old_qty - new_qty) AS velocity14d
        FROM price_history
        WHERE change_type = 'stock_change'
          AND detected_at > cast(strftime('%s','now','-14 days') as integer)
          AND old_qty > new_qty
        GROUP BY sku
      ) v ON v.sku = p.sku
      WHERE p.shopify_product_id IS NOT NULL AND p.shopify_product_id != ''
        AND (p.product_type IS NULL OR p.product_type NOT LIKE ?)
        AND (${poolWhereSql})
    `,
    args: [PATIO_PREFIX, ...poolArgs],
  });
  return result.rows.map((r) => ({
    sku: String(r.sku),
    productType: (r.product_type as string) ?? null,
    velocity14d: Number(r.velocity14d) || 0,
    hasDiscount: Number(r.has_discount) === 1,
  }));
}

function seasonalTag(productType: string | null): ScoredCandidate["seasonalMultiplier"] {
  if (!productType) return "neutral";
  if (productType.startsWith(INDOOR_PREFIX.replace("%", ""))) return "indoor";
  if (SEASONAL_KEYWORDS.some((kw) => productType.includes(kw.replace(/%/g, "")))) return "seasonal-keyword";
  return "neutral";
}

/**
 * Score + rank candidates: velocity 60% + discount-flag 40% (min-max normalized velocity
 * within THIS set), times a seasonal multiplier. Highest priority first.
 */
export function scoreAndRank(candidates: PriorityCandidate[]): ScoredCandidate[] {
  const maxVel = Math.max(1, ...candidates.map((c) => c.velocity14d));
  const scored = candidates.map((c) => {
    const velocityScore = c.velocity14d / maxVel;
    const discountScore = c.hasDiscount ? 1 : 0;
    const trendScore = velocityScore * VELOCITY_WEIGHT + discountScore * DISCOUNT_WEIGHT;
    const tag = seasonalTag(c.productType);
    const multiplier = tag === "indoor" ? INDOOR_BOOST : tag === "seasonal-keyword" ? SEASONAL_KEYWORD_BOOST : 1.0;
    return {
      ...c,
      velocityScore,
      discountScore,
      trendScore,
      seasonalMultiplier: tag,
      priority: trendScore * multiplier,
    };
  });
  return scored.sort((a, b) => b.priority - a.priority);
}

/** Convenience: fetch + score + rank + take the top N in one call. */
export async function topPriorityCandidates(
  poolWhereSql: string,
  poolArgs: (string | number)[],
  limit: number,
): Promise<ScoredCandidate[]> {
  const candidates = await fetchPriorityCandidates(poolWhereSql, poolArgs);
  return scoreAndRank(candidates).slice(0, limit);
}
