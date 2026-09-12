/**
 * Storefront payload for the landing page's two trend-driven sections:
 * "Les plus demandés cette semaine" (product carousel) and the popular
 * subcategory tile grid. Consumed by `GET /api/trending`.
 *
 * Split of work, deliberately:
 *
 *  - The TILES are hydrated by the weekly cron and read back verbatim from
 *    `trend_scores.metadata`. A tile shows a title and a cover photo, both of
 *    which are stable for a week, so serving one costs a single indexed Turso
 *    read and zero Shopify calls.
 *  - The PRODUCT CARDS are hydrated per request from the live Shopify product,
 *    because they carry a PRICE. `products.price` in Turso is the SUPPLIER price,
 *    not the retail price the storefront charges (the import pipeline applies the
 *    markup), so it can never be shown to a shopper — the same trap
 *    `/api/ugc-videos` hit in v0.5.54.24. The route edge-caches the result for
 *    30 minutes, exactly as that route does.
 *
 * Both levels exclude out-of-stock products: the scorer never scores them, and
 * this layer additionally drops anything no longer `active` on Shopify.
 */
import { getTopTrendScores, getTrendScoresComputedAt } from "@/lib/database";
import { resolveProductFields } from "@/lib/selectors/shopify-product";
import { discountPct } from "@/lib/slideshow/validate";
import { shopifyFetch } from "@/lib/shopify-client";

export interface TrendingProductCard {
  sku: string;
  /** Curated FR title (live Shopify product title) — never `products.name`. */
  titleFr: string;
  /** Curated EN title (`custom.title_en` metafield; FR title when absent). */
  titleEn: string;
  /** Shopify handle — the storefront builds `/products/{handle}` (locale-aware). */
  handle: string;
  price: number;
  /** Pre-discount price, ONLY when the rabais is ≥10%; null otherwise. */
  compareAtPrice: number | null;
  /** Rounded % off, or null when under the ≥10% rule. */
  discountPct: number | null;
  currency: string;
  imageUrl: string | null;
  /** Composite trend score, 0..1 (for debugging / the ops report). */
  score: number;
}

export interface TrendingSubcategoryTile {
  collectionId: string;
  handle: string;
  titleFr: string;
  titleEn: string;
  /** Cover photo (a Shopify-CDN product photo from the collection), or null. */
  imageUrl: string | null;
  score: number;
  productCount: number;
}

export interface TrendingSections {
  products: TrendingProductCard[];
  subcategories: TrendingSubcategoryTile[];
  /** Unix seconds of the last trend-score computation, or null when never run. */
  computedAt: number | null;
}

/** How many product cards the carousel asks for. */
export const PRODUCT_CARD_COUNT = 12;

/** Resolve the curated EN title from the `custom.title_en` metafield; FR fallback. */
async function resolveTitleEn(shopifyProductId: string, fallback: string): Promise<string> {
  try {
    const res = await shopifyFetch(
      `/products/${encodeURIComponent(shopifyProductId)}/metafields.json?namespace=custom`,
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as { metafields?: Array<{ key: string; value: string }> };
    return (data.metafields ?? []).find((m) => m.key === "title_en")?.value?.trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build the product carousel. Walks the stored ranking best-first and keeps the
 * first `count` products that are still sellable: live (`status: "active"`) on
 * Shopify, with a curated FR title and a handle. Extra candidates are pulled as
 * headroom so drop-outs don't shorten the carousel.
 */
export async function getTrendingProductCards(count = PRODUCT_CARD_COUNT): Promise<TrendingProductCard[]> {
  const ranked = await getTopTrendScores("product", count + 10);
  const cards: TrendingProductCard[] = [];

  for (const row of ranked) {
    if (cards.length >= count) break;
    const meta = row.metadata ?? {};
    const shopifyProductId = typeof meta.shopifyProductId === "string" ? meta.shopifyProductId : "";
    if (!shopifyProductId) continue;

    const fields = await resolveProductFields(shopifyProductId);
    if (fields.status !== "active") continue;

    const titleFr = fields.titleFr.trim();
    if (!titleFr) continue;
    const handle = fields.handle || (typeof meta.handle === "string" ? meta.handle : "");
    if (!handle) continue;

    const price = Number(fields.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    // Live Shopify compare-at, put through the store's canonical ≥10% gate — the
    // strikethrough must never appear for a smaller rabais.
    const rawCompareAt = fields.compareAtPrice == null ? NaN : Number(fields.compareAtPrice);
    const pct = discountPct(price, Number.isFinite(rawCompareAt) ? rawCompareAt : undefined);
    const titleEn = await resolveTitleEn(shopifyProductId, titleFr);

    cards.push({
      sku: row.entityId,
      titleFr,
      titleEn,
      handle,
      price,
      compareAtPrice: pct == null ? null : rawCompareAt,
      discountPct: pct ?? null,
      currency: "CAD",
      // pos-1 is the clean lifestyle photo when one exists (rule inverted in
      // July 2026); `images[0]` is the array-order fallback.
      imageUrl: fields.lifestyle.primaryImageUrl ?? fields.images[0] ?? null,
      score: row.score,
    });
  }
  return cards;
}

/**
 * The subcategory tiles, straight out of the stored metadata the cron wrote.
 * Only collections the cron stamped with a `tileRank` are returned, in that
 * order — those are the ones that survived de-overlap and per-root diversity.
 */
export async function getTrendingSubcategoryTiles(): Promise<TrendingSubcategoryTile[]> {
  const ranked = await getTopTrendScores("collection", 100);
  const tiles: Array<TrendingSubcategoryTile & { tileRank: number }> = [];

  for (const row of ranked) {
    const meta = row.metadata ?? {};
    const tileRank = typeof meta.tileRank === "number" ? meta.tileRank : null;
    if (tileRank === null) continue;
    const handle = typeof meta.handle === "string" ? meta.handle : "";
    const titleFr = typeof meta.titleFr === "string" ? meta.titleFr : "";
    if (!handle || !titleFr) continue;
    tiles.push({
      tileRank,
      collectionId: row.entityId,
      handle,
      titleFr,
      titleEn: (typeof meta.titleEn === "string" && meta.titleEn) || titleFr,
      imageUrl: typeof meta.imageUrl === "string" && meta.imageUrl ? meta.imageUrl : null,
      score: row.score,
      productCount: typeof meta.productCount === "number" ? meta.productCount : 0,
    });
  }

  return tiles
    .sort((a, b) => a.tileRank - b.tileRank)
    .map(({ tileRank: _drop, ...tile }) => tile);
}

/** Both sections in one payload. */
export async function getTrendingSections(
  productCount = PRODUCT_CARD_COUNT,
): Promise<TrendingSections> {
  const [products, subcategories, computedAt] = await Promise.all([
    getTrendingProductCards(productCount),
    getTrendingSubcategoryTiles(),
    getTrendScoresComputedAt(),
  ]);
  return { products, subcategories, computedAt };
}
