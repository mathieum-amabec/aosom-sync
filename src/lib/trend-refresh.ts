/**
 * Weekly trend-score refresh — the write side of `lib/trend-score.ts`.
 *
 * Recomputes both levels of the composite score and replaces the `trend_scores`
 * table, then hydrates the eight tiles that actually reach the landing page with
 * the two stable things a tile needs (its EN title and a cover photo) so serving
 * one costs no Shopify call at all.
 *
 * TURSO + SHOPIFY READS ONLY. Nothing here writes to Shopify: no product, no
 * collection, no theme asset is touched. The only mutation is to `trend_scores`.
 */
import {
  computeTrendScores,
  TREND_WINDOW_DAYS,
  DEFAULT_TREND_WEIGHTS,
  type TrendWeights,
  type ScoredCollection,
} from "@/lib/trend-score";
import { replaceTrendScores, type TrendScoreWrite } from "@/lib/database";
import { resolveProductFields } from "@/lib/selectors/shopify-product";
import { shopifyFetch } from "@/lib/shopify-client";

/**
 * How many product scores to persist. The carousel shows 12 and skips anything
 * that fell out of `active` on Shopify, so a deep bench keeps it full without
 * storing all ~2 300 scored products.
 */
export const PERSISTED_PRODUCT_COUNT = 60;

export interface TrendRefreshResult {
  productsScored: number;
  productsWritten: number;
  collectionsScored: number;
  collectionsWritten: number;
  tiles: Array<{ handle: string; titleFr: string; score: number; hasImage: boolean }>;
  windowDays: number;
  weights: TrendWeights;
  computedAt: number;
  durationMs: number;
}

/** EN titles for a batch of collections, via the Translations API. Missing → undefined. */
async function fetchCollectionTitlesEn(collectionIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (collectionIds.length === 0) return out;
  try {
    const res = await shopifyFetch("/graphql.json", {
      method: "POST",
      body: JSON.stringify({
        query: `query($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Collection { id translations(locale: "en") { key value } }
          }
        }`,
        variables: { ids: collectionIds.map((id) => `gid://shopify/Collection/${id}`) },
      }),
    });
    if (!res.ok) return out;
    const body = (await res.json()) as {
      data?: { nodes?: Array<{ id?: string; translations?: Array<{ key: string; value: string }> } | null> };
    };
    for (const node of body.data?.nodes ?? []) {
      if (!node?.id) continue;
      const value = (node.translations ?? []).find((t) => t.key === "title")?.value?.trim();
      if (value) out.set(node.id.split("/").pop() as string, value);
    }
  } catch {
    // A missing EN title degrades to the FR one — never fail the refresh over it.
  }
  return out;
}

/**
 * Cover photo for a tile, borrowed from what is actually selling inside the
 * collection — subcategory collections carry no image of their own (3 of 105 do).
 *
 * TWO PASSES, and the order matters. A category tile is a lifestyle surface: the
 * main category grid directly above it is all room photos, so a white-background
 * cut-out looks broken next to it, and a DIMENSIONED SPEC DIAGRAM looks like a
 * bug. Taking the best-scoring product's position-1 photo produced exactly that
 * ("Foyers extérieurs" came back as a measurement drawing), because
 * `isSpecImageUrl` filters on URL keywords and these filenames carry none.
 *
 * So: first pass takes the best-scoring product tagged `lifestyle-verified`,
 * whose position-1 photo is a real in-room shot by definition. Only if no
 * candidate is tagged does the second pass fall back to any photo at all.
 */
async function resolveTileCover(
  collection: ScoredCollection,
  skuToProductId: Map<string, string>,
): Promise<string | null> {
  let fallback: string | null = null;

  for (const sku of collection.topSkus) {
    const productId = skuToProductId.get(sku);
    if (!productId) continue;
    const fields = await resolveProductFields(productId);
    if (fields.status !== "active") continue;
    // pos-1 is the clean lifestyle shot when one exists; array-order otherwise.
    const url = fields.lifestyle.primaryImageUrl ?? fields.images[0] ?? null;
    if (!url) continue;
    if (fields.lifestyle.verified) return url;
    if (!fallback) fallback = url;
  }
  return fallback;
}

/**
 * Recompute and persist. Returns a summary suitable for the cron response and
 * the ops report.
 */
export async function refreshTrendScores(
  opts: { windowDays?: number; weights?: TrendWeights } = {},
): Promise<TrendRefreshResult> {
  const startedAt = Date.now();
  const windowDays = opts.windowDays ?? TREND_WINDOW_DAYS;
  const weights = opts.weights ?? { ...DEFAULT_TREND_WEIGHTS };

  const result = await computeTrendScores({ windowDays, weights });
  const skuToProductId = new Map(result.products.map((p) => [p.sku, p.shopifyProductId]));

  // ── tiles: the only collections worth a Shopify round-trip ──────────────
  const tiles = result.collections
    .filter((c) => c.tileRank !== null)
    .sort((a, b) => (a.tileRank as number) - (b.tileRank as number));
  const titlesEn = await fetchCollectionTitlesEn(tiles.map((t) => t.collectionId));
  const covers = new Map<string, string | null>();
  for (const tile of tiles) {
    covers.set(tile.collectionId, await resolveTileCover(tile, skuToProductId));
  }

  const writes: TrendScoreWrite[] = [];

  for (const p of result.products.slice(0, PERSISTED_PRODUCT_COUNT)) {
    writes.push({
      entityType: "product",
      entityId: p.sku,
      score: p.score,
      metadata: {
        shopifyProductId: p.shopifyProductId,
        handle: p.shopifyHandle,
        productType: p.productType,
        velocity: p.velocity,
        discountPct: p.discountPct,
        velocityNorm: Number(p.velocityNorm.toFixed(4)),
        discountNorm: Number(p.discountNorm.toFixed(4)),
        qty: p.qty,
      },
    });
  }

  for (const c of result.collections) {
    writes.push({
      entityType: "collection",
      entityId: c.collectionId,
      score: c.score,
      metadata: {
        handle: c.handle,
        titleFr: c.title,
        titleEn: titlesEn.get(c.collectionId) ?? c.title,
        productCount: c.productCount,
        topSkus: c.topSkus,
        rootCategory: c.rootCategory,
        tileRank: c.tileRank,
        imageUrl: covers.get(c.collectionId) ?? null,
      },
    });
  }

  await replaceTrendScores(writes, result.computedAt);

  return {
    productsScored: result.products.length,
    productsWritten: Math.min(result.products.length, PERSISTED_PRODUCT_COUNT),
    collectionsScored: result.collections.length,
    collectionsWritten: result.collections.length,
    tiles: tiles.map((t) => ({
      handle: t.handle,
      titleFr: t.title,
      score: Number(t.score.toFixed(4)),
      hasImage: Boolean(covers.get(t.collectionId)),
    })),
    windowDays,
    weights,
    computedAt: result.computedAt,
    durationMs: Date.now() - startedAt,
  };
}
