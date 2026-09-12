/**
 * Composite "trending" score — powers the landing page's "Les plus demandés
 * cette semaine" carousel and the popular-subcategory tile grid.
 *
 * Everything is derived from data the daily sync already writes to Turso. There
 * is NO new network call to Aosom (programmatic requests there 403), and no new
 * signal: the two components REUSE the exact logic the dashboard already ships.
 *
 *   - Velocity  — `SUM(old_qty - new_qty)` over `stock_change` price_history rows
 *                 in the window where stock went DOWN. Identical to
 *                 `selectors/best-sellers.ts` ("Fastest Selling").
 *   - Price drop — the derived compare-at from `selectors/map.ts`
 *                 (`compareAtSubquery`) run through the store's canonical
 *                 `discountPct()` gate. Identical to `selectors/price-drops.ts`.
 *
 * Both components are normalised to 0..1 before they are combined, so a product
 * moving 40 units and a product at 45% off are on one scale.
 *
 * WEIGHTING — 60% velocity / 40% price drop. Velocity is revealed demand: it is
 * the only signal here that says a real customer chose the product, so it leads.
 * The discount is an *offer*, not a behaviour — it predicts demand rather than
 * proving it — but it is what makes a landing-page tile worth clicking, so it
 * gets a substantial, not token, share. 60/40 keeps a deeply-discounted product
 * that nobody buys out of the top slots while still letting a fresh rabais break
 * into them. Both weights are parameters (`TrendWeights`), so the split can be
 * retuned without touching the SQL.
 *
 * Out-of-stock products are excluded outright (`qty > 0`), at every level:
 * nothing unbuyable reaches the carousel, and nothing unbuyable contributes to a
 * subcategory's score.
 */
import type { Row } from "@libsql/client";
import { getSelectorDb } from "@/lib/selectors/db";
import { compareAtSubquery } from "@/lib/selectors/map";
import { discountPct } from "@/lib/slideshow/validate";
import { shopifyFetch } from "@/lib/shopify-client";

/** Rolling window, in days, for both components. */
export const TREND_WINDOW_DAYS = 14;

/** Default component weights. Must sum to 1. */
export const DEFAULT_TREND_WEIGHTS = { velocity: 0.6, discount: 0.4 } as const;

/**
 * Velocity is LOG-scaled and normalised against the 99th percentile of the
 * candidate set. Measured on the live catalog (2026-09-11, 2254 products with
 * movement): velocity is brutally long-tailed — p50 = 6 units, p95 = 29,
 * max = 604. Dividing by the max squashes everything to ~0; dividing linearly by
 * p95 saturates 113 products at exactly 1.0, which made the velocity component
 * constant across the whole top of the ranking and silently handed the ordering
 * to the discount alone (9 of the top 10 sat at vNorm = 1.00). log1p/p99 cut
 * that to 3 of 10 and let a deeply-discounted slow mover trade places with a
 * fast mover at list price — which is what a composite score is FOR.
 */
export const VELOCITY_PERCENTILE = 0.99;

/**
 * A rabais at or above this is a maximal price signal (1.0). A FIXED anchor,
 * deliberately — max-normalising the discount would hand a 2% rabais a perfect
 * score in a week where nothing is on sale.
 */
export const DISCOUNT_ANCHOR_PCT = 50;

/** A collection's score is the mean of its top-N product scores. */
export const COLLECTION_TOP_N = 5;

/**
 * Two subcategory collections whose membership overlaps by more than this (as
 * containment, |A∩B| / min(|A|,|B|)) are near-duplicates; only the better-scoring
 * one may take a tile. Shopify's subcategories nest — "Bureaux d'ordinateur" is a
 * strict subset of "Bureaux" — so without this the 8 tiles collapsed into four
 * ways of saying "office desk" (verified on live data).
 */
export const MAX_TILE_OVERLAP = 0.6;

/**
 * At most this many tiles may come from one top-level Aosom category, so the
 * grid spans the store instead of eight shades of one department.
 */
export const MAX_TILES_PER_ROOT = 2;

/** How many subcategory tiles the landing-page grid shows. */
export const TILE_COUNT = 8;

/**
 * A subcategory needs this many scored, in-stock products to be rankable — it
 * stops a collection with one hot item (or an almost-empty one) from taking a
 * tile away from a genuinely busy category.
 */
export const MIN_COLLECTION_PRODUCTS = 3;

export interface TrendWeights {
  velocity: number;
  discount: number;
}

export interface ScoredProduct {
  sku: string;
  productType: string;
  shopifyProductId: string;
  shopifyHandle: string | null;
  qty: number;
  price: number;
  compareAtPrice: number | null;
  /** Units depleted over the window (raw). */
  velocity: number;
  /** Rounded % off, or 0 when under the store's ≥10% rabais rule. */
  discountPct: number;
  /** Velocity component, 0..1. */
  velocityNorm: number;
  /** Price-drop component, 0..1. */
  discountNorm: number;
  /** Composite score, 0..1. */
  score: number;
}

export interface ScoredCollection {
  /** Shopify collection id (numeric, as a string). */
  collectionId: string;
  handle: string;
  title: string;
  /** Mean of the top `COLLECTION_TOP_N` product scores. */
  score: number;
  /** In-stock scored products matched into this collection. */
  productCount: number;
  /** Best-scoring SKUs, best first — the first is the tile's cover product. */
  topSkus: string[];
  /** Top-level Aosom category most of its members sit under ("Patio & Garden"). */
  rootCategory: string;
  /**
   * 0-based position in the subcategory tile grid, or null when the collection
   * was ranked but dropped by de-overlap / per-root diversity. Only ranks
   * 0..TILE_COUNT-1 are ever assigned.
   */
  tileRank: number | null;
}

export interface TrendScoreResult {
  products: ScoredProduct[];
  collections: ScoredCollection[];
  windowDays: number;
  weights: TrendWeights;
  computedAt: number;
}

/** One `type contains "..."`-style rule off a Shopify smart collection. */
interface TypeRule {
  relation: "contains" | "not_contains" | "equals" | "not_equals";
  condition: string;
}

interface CollectionRuleSet {
  collectionId: string;
  handle: string;
  title: string;
  disjunctive: boolean;
  rules: TypeRule[];
}

/**
 * Handles that are NOT subcategories: the eight main category tiles (which have
 * their own fixed grid directly above), plus catch-all / merchandising
 * collections whose membership says nothing about a product category.
 */
const NON_SUBCATEGORY_HANDLES = new Set([
  // The 8 main tiles (see the `cat_tiles` section on the homepage).
  "meubles-deco",
  "exterieur-et-jardin",
  "bricolage-et-outils",
  "animaux",
  "enfants",
  "sport-et-loisirs",
  "electro-et-tech",
  "rabais",
  // Catch-all / cross-category merchandising.
  "nouveaux-arrivages",
  "nouveaux-arrivages-lifestyle",
  "rabais-lifestyle",
  "coups-de-coeur",
  "deco-saisonniere",
  "noel",
  "halloween",
  "bureau-et-travail",
  "sante-et-beaute",
]);

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Value at `p` (0..1) of an ascending-sorted array, nearest-rank. Returns 0 for
 * an empty array so callers can divide defensively.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(rank, 0), sortedAsc.length - 1)];
}

/**
 * Pull every in-stock, imported product with its window velocity and its derived
 * compare-at price. One query — the velocity sub-select is served by
 * `idx_ph_velocity`, the compare-at correlated sub-select by
 * `idx_price_history_sku_detected`.
 */
async function fetchCandidates(windowDays: number): Promise<Row[]> {
  const db = await getSelectorDb();
  const result = await db.execute({
    sql: `
      SELECT p.sku AS sku,
             p.product_type AS product_type,
             p.shopify_product_id AS shopify_product_id,
             p.shopify_handle AS shopify_handle,
             p.qty AS qty,
             p.price AS price,
             COALESCE(v.velocity, 0) AS velocity,
             ${compareAtSubquery("p")} AS compare_at_price
      FROM products p
      LEFT JOIN (
        SELECT sku, SUM(old_qty - new_qty) AS velocity
        FROM price_history
        WHERE change_type = 'stock_change'
          AND detected_at > cast(strftime('%s','now', ?) as integer)
          AND old_qty > new_qty
        GROUP BY sku
      ) v ON v.sku = p.sku
      WHERE p.shopify_product_id IS NOT NULL
        AND p.shopify_product_id != ''
        AND p.qty > 0`,
    args: [`-${windowDays} days`],
  });
  return result.rows;
}

/**
 * Normalise both components across the candidate set and combine them.
 * Exported for tests: this is the whole scoring model, with no I/O.
 */
export function scoreProducts(
  rows: Array<{
    sku: string;
    product_type: unknown;
    shopify_product_id: unknown;
    shopify_handle: unknown;
    qty: unknown;
    price: unknown;
    velocity: unknown;
    compare_at_price: unknown;
  }>,
  weights: TrendWeights = DEFAULT_TREND_WEIGHTS,
): ScoredProduct[] {
  const velocities = rows.map((r) => num(r.velocity)).filter((v) => v > 0).sort((a, b) => a - b);
  const anchor = percentile(velocities, VELOCITY_PERCENTILE);

  return rows
    .map((r) => {
      const price = num(r.price);
      const compareAtPrice = optNum(r.compare_at_price);
      const velocity = num(r.velocity);
      // `discountPct` IS the store's ≥10% rabais rule; under it there is no
      // badge, no strikethrough, and here no price signal either.
      const pct = discountPct(price, compareAtPrice ?? undefined) ?? 0;

      const velocityNorm =
        anchor > 0 ? Math.min(Math.log1p(velocity) / Math.log1p(anchor), 1) : 0;
      const discountNorm = Math.min(pct / DISCOUNT_ANCHOR_PCT, 1);
      const score = weights.velocity * velocityNorm + weights.discount * discountNorm;

      return {
        sku: r.sku,
        productType: typeof r.product_type === "string" ? r.product_type : "",
        shopifyProductId: String(r.shopify_product_id ?? ""),
        shopifyHandle: typeof r.shopify_handle === "string" && r.shopify_handle ? r.shopify_handle : null,
        qty: num(r.qty),
        price,
        compareAtPrice,
        velocity,
        discountPct: pct,
        velocityNorm,
        discountNorm,
        score,
      };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * Live subcategory collections, read from Shopify — NOT from
 * `collection_mappings`, which is stale: 6 of its 14 distinct sub-role
 * collection ids 404 on both the REST and GraphQL APIs (verified 2026-09-11), so
 * tiles built from it would link to dead collections.
 *
 * Only smart collections whose rules are ALL `column: "type"` are usable, because
 * those rules can be evaluated against `products.product_type` offline. Tag- and
 * title-ruled collections are skipped: their membership isn't derivable from
 * Turso. That leaves ~90 candidates, which is a real ranking pool.
 */
export async function fetchSubcategoryRuleSets(): Promise<CollectionRuleSet[]> {
  const res = await shopifyFetch(
    "/smart_collections.json?fields=id,handle,title,published_at,rules,disjunctive&limit=250",
  );
  if (!res.ok) throw new Error(`smart_collections ${res.status}`);
  const data = (await res.json()) as {
    smart_collections?: Array<{
      id: number | string;
      handle: string;
      title: string;
      published_at: string | null;
      disjunctive?: boolean;
      rules?: Array<{ column: string; relation: string; condition: string }>;
    }>;
  };

  const out: CollectionRuleSet[] = [];
  for (const c of data.smart_collections ?? []) {
    if (!c.published_at) continue;
    if (NON_SUBCATEGORY_HANDLES.has(c.handle)) continue;
    const rules = c.rules ?? [];
    if (rules.length === 0) continue;
    if (!rules.every((r) => r.column === "type")) continue;
    out.push({
      collectionId: String(c.id),
      handle: c.handle,
      title: c.title,
      disjunctive: Boolean(c.disjunctive),
      rules: rules.map((r) => ({ relation: r.relation as TypeRule["relation"], condition: r.condition })),
    });
  }
  return out;
}

/** Evaluate one Shopify `type` rule against a product_type, Shopify's semantics. */
function ruleMatches(productType: string, rule: TypeRule): boolean {
  const haystack = productType.toLowerCase();
  const needle = rule.condition.toLowerCase();
  switch (rule.relation) {
    case "contains":
      return haystack.includes(needle);
    case "not_contains":
      return !haystack.includes(needle);
    case "equals":
      return haystack === needle;
    case "not_equals":
      return haystack !== needle;
    default:
      return false;
  }
}

/** True when a product_type satisfies a collection's rule set (OR vs AND). */
export function collectionMatches(productType: string, set: CollectionRuleSet): boolean {
  if (!productType) return false;
  return set.disjunctive
    ? set.rules.some((r) => ruleMatches(productType, r))
    : set.rules.every((r) => ruleMatches(productType, r));
}

/**
 * Roll scored products up to subcategory collections.
 *
 * A collection's score is the MEAN OF ITS TOP `COLLECTION_TOP_N` PRODUCT SCORES,
 * not a sum and not a full mean. A sum would just rank collections by size —
 * the biggest collection always wins, which tells a shopper nothing. A full mean
 * would let a 4-product collection with one hot item outrank a busy one. The
 * top-N mean asks the question the tile actually answers: "is there a cluster of
 * things moving in here right now?"
 */
export function aggregateCollections(
  products: ScoredProduct[],
  sets: CollectionRuleSet[],
  minProducts: number = MIN_COLLECTION_PRODUCTS,
): ScoredCollection[] {
  const scored: Array<ScoredCollection & { memberSkus: Set<string> }> = [];
  for (const set of sets) {
    const members = products.filter((p) => collectionMatches(p.productType, set));
    if (members.length < minProducts) continue;
    // `products` is already sorted best-first, so `members` is too.
    const top = members.slice(0, COLLECTION_TOP_N);
    const score = top.reduce((s, p) => s + p.score, 0) / top.length;
    scored.push({
      collectionId: set.collectionId,
      handle: set.handle,
      title: set.title,
      score,
      productCount: members.length,
      topSkus: top.map((p) => p.sku),
      rootCategory: modalRootCategory(members),
      tileRank: null,
      memberSkus: new Set(members.map((p) => p.sku)),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  assignTileRanks(scored);
  // Drop the working membership set — it is large (hundreds of SKUs) and never
  // leaves this function.
  return scored.map(({ memberSkus: _drop, ...rest }) => rest);
}

/** The top-level Aosom category ("Patio & Garden") most members sit under. */
function modalRootCategory(members: ScoredProduct[]): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    const root = (m.productType.split(">")[0] ?? "").trim();
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [root, n] of counts) {
    if (n > bestN) {
      best = root;
      bestN = n;
    }
  }
  return best;
}

/** Containment overlap: |A∩B| / min(|A|,|B|). 1.0 when one is a subset of the other. */
export function containment(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let hits = 0;
  for (const sku of small) if (large.has(sku)) hits++;
  return hits / small.size;
}

/**
 * Walk the ranked collections best-first and stamp `tileRank` on the ones that
 * earn a tile: skip anything that near-duplicates an already-picked collection
 * (containment > MAX_TILE_OVERLAP) or that would be the third tile from the same
 * top-level category. Mutates in place; stops once TILE_COUNT tiles are filled.
 */
function assignTileRanks(scored: Array<ScoredCollection & { memberSkus: Set<string> }>): void {
  const picked: Array<ScoredCollection & { memberSkus: Set<string> }> = [];
  const perRoot = new Map<string, number>();
  for (const c of scored) {
    if (picked.length >= TILE_COUNT) break;
    if (picked.some((p) => containment(p.memberSkus, c.memberSkus) > MAX_TILE_OVERLAP)) continue;
    const usedByRoot = perRoot.get(c.rootCategory) ?? 0;
    if (c.rootCategory && usedByRoot >= MAX_TILES_PER_ROOT) continue;
    c.tileRank = picked.length;
    perRoot.set(c.rootCategory, usedByRoot + 1);
    picked.push(c);
  }
}

/**
 * Compute both levels of the trend score. Pure read: Turso for the signals,
 * Shopify only to read the live collection rules. Writes nothing.
 */
export async function computeTrendScores(
  opts: { windowDays?: number; weights?: TrendWeights } = {},
): Promise<TrendScoreResult> {
  const windowDays = opts.windowDays ?? TREND_WINDOW_DAYS;
  const weights = opts.weights ?? { ...DEFAULT_TREND_WEIGHTS };

  const rows = await fetchCandidates(windowDays);
  const products = scoreProducts(rows as unknown as Parameters<typeof scoreProducts>[0], weights);
  const sets = await fetchSubcategoryRuleSets();
  const collections = aggregateCollections(products, sets);

  return {
    products,
    collections,
    windowDays,
    weights,
    computedAt: Math.floor(Date.now() / 1000),
  };
}
