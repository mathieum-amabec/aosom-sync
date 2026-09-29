/**
 * Second source of pSEO guide topics: the store's own fine-grained FRENCH smart collections
 * ("Chaises de bureau", "Tabourets de bar", "Range-chaussures"…), once every collection_mappings
 * 'sub' subcategory has its guide (coverage reached 28/28 on 2026-09-27).
 *
 * Why collections and not raw product_type leaves: each one already has a curated French
 * title, a real public URL to link to, and an exact product membership — so the guide
 * compares products that are actually on the page it links to.
 *
 * Guardrails against scaled/doorway content (Google's "scaled content abuse" policy):
 *   - only category collections (every rule is on product type) — never tag/price/marketing
 *     collections like "Rabais" or "Nouveaux arrivages" — and never a whole store department
 *     ("Meubles & Déco", "Animaux"): 3 products can't make a real guide for 1 000;
 *   - a topic whose French title matches an existing guide's is the same subject — skipped;
 *   - at least MIN_IN_STOCK in-stock products, so the comparison is never thin;
 *   - near-duplicate topics are skipped: a candidate whose in-stock products are ≥ 80 %
 *     covered by an existing guide (or an earlier candidate) of similar size gets no page.
 * Cadence (how many per week) is the cron's job — see /api/cron/guide-batch.
 *
 * guide_pages rows for these topics use the synthetic key `collection:<handle>` in
 * aosom_category (NOT NULL, and unique per topic).
 */
import { shopifyFetch, parseLinkHeader } from "./shopify-client";
import {
  getTrendStatsForShopifyProductIds,
  getInStockShopifyIdsForCategory,
  getProductDepartments,
  getGuidePages,
  type SubcategoryTrendStats,
} from "./database";

export const COLLECTION_TOPIC_PREFIX = "collection:";
export const MIN_IN_STOCK = 10;
/** Share of a candidate's in-stock products already covered that makes it a near-duplicate. */
const DUPLICATE_OVERLAP = 0.8;
/** …but only when the covering set isn't much larger (a child of a broad guide is fine). */
const DUPLICATE_MAX_SIZE_RATIO = 1.25;

export interface CollectionTopic {
  key: string; // collection:<handle>
  collectionId: string;
  handle: string;
  title: string;
  productTypes: string[];
}

interface ShopifySmartCollection {
  id: number;
  handle: string;
  title: string;
  published_at: string | null;
  rules: { column: string; relation: string; condition: string }[] | null;
}

export function isCollectionTopicKey(key: string): boolean {
  return key.startsWith(COLLECTION_TOPIC_PREFIX);
}

/** Published smart collections whose every rule is on product type (a category, not a promo). */
export async function listCollectionTopics(): Promise<CollectionTopic[]> {
  const topics: CollectionTopic[] = [];
  let pageInfo: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,handle,title,published_at,rules" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await shopifyFetch(`/smart_collections.json?${params}`);
    if (!res.ok) throw new Error(`[guide-topics] smart_collections list failed: ${res.status}`);
    const data = (await res.json()) as { smart_collections?: ShopifySmartCollection[] };
    for (const c of data.smart_collections ?? []) {
      const rules = c.rules ?? [];
      if (!c.published_at || rules.length === 0 || !rules.every((r) => r.column === "type")) continue;
      topics.push({
        key: `${COLLECTION_TOPIC_PREFIX}${c.handle}`,
        collectionId: String(c.id),
        handle: c.handle,
        title: c.title,
        productTypes: rules.map((r) => r.condition),
      });
    }
    pageInfo = parseLinkHeader(res.headers.get("Link"));
  } while (pageInfo);
  return topics;
}

/** The collection's REAL product membership, as Shopify computes it. */
export async function getCollectionProductIds(collectionId: string): Promise<string[]> {
  const ids: string[] = [];
  let pageInfo: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await shopifyFetch(`/collections/${collectionId}/products.json?${params}`);
    if (!res.ok) throw new Error(`[guide-topics] collection ${collectionId} products failed: ${res.status}`);
    const data = (await res.json()) as { products?: { id: number }[] };
    ids.push(...(data.products ?? []).map((p) => String(p.id)));
    pageInfo = parseLinkHeader(res.headers.get("Link"));
  } while (pageInfo);
  return ids;
}

/** Holiday topics jump the queue from October 1 to December 10, so a Christmas-tree guide is
 * live while people actually search for it. */
export function isInSeason(topic: CollectionTopic, now: Date = new Date()): boolean {
  const holiday = topic.productTypes.some((t) => /Holiday|Christmas|Halloween/i.test(t)) || /no[eë]l|sapin|halloween/i.test(topic.title);
  if (!holiday) return false;
  const m = now.getUTCMonth(); // 0-based
  return m === 9 || m === 10 || (m === 11 && now.getUTCDate() <= 10);
}

/** Case/accent-insensitive title key ("Salle de bain" === "salle de Bain"). */
export function titleKey(title: string): string {
  return title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isNearDuplicate(candidate: Set<string>, covering: Set<string>): boolean {
  if (candidate.size === 0 || covering.size === 0) return false;
  let shared = 0;
  for (const id of candidate) if (covering.has(id)) shared++;
  return shared / candidate.size >= DUPLICATE_OVERLAP && covering.size <= candidate.size * DUPLICATE_MAX_SIZE_RATIO;
}

export interface CollectionCandidate {
  stats: SubcategoryTrendStats;
  collectionHandle: string;
}

export interface CollectionSelection {
  candidates: CollectionCandidate[];
  /** Eligible topics still without a guide (the cron's "is there anything left?" signal). */
  remainingEligible: number;
  skipped: { key: string; title: string; reason: string }[];
}

/**
 * Picks up to `count` collection topics for new guides. `coveredKeys` = every aosom_category
 * already in guide_pages (any status). In-season topics first, then trend score, then size.
 */
export async function selectCollectionCandidates(
  count: number,
  coveredKeys: Set<string>,
  now: Date = new Date(),
): Promise<CollectionSelection> {
  const [allTopics, departments, guides] = await Promise.all([listCollectionTopics(), getProductDepartments(), getGuidePages()]);
  const coveredTitles = new Set(guides.map((g) => titleKey(g.shopify_collection_title || "")));
  const topicByKey = new Map(allTopics.map((t) => [t.key, t]));
  const skipped: CollectionSelection["skipped"] = [];
  const topics = allTopics.filter((t) => {
    if (t.productTypes.some((pt) => departments.has(pt.trim()))) {
      skipped.push({ key: t.key, title: t.title, reason: "rayon entier (trop large pour un guide)" });
      return false;
    }
    if (!coveredKeys.has(t.key) && coveredTitles.has(titleKey(t.title))) {
      skipped.push({ key: t.key, title: t.title, reason: "même sujet qu'un guide existant (titre identique)" });
      return false;
    }
    return true;
  });

  // Product sets of every existing guide, to detect near-duplicates.
  const coveringSets: Set<string>[] = [];
  for (const key of coveredKeys) {
    if (isCollectionTopicKey(key)) {
      const t = topicByKey.get(key);
      if (t) coveringSets.push(new Set(await getCollectionProductIds(t.collectionId)));
    } else {
      coveringSets.push(new Set(await getInStockShopifyIdsForCategory(key)));
    }
  }

  const eligible: { topic: CollectionTopic; stats: SubcategoryTrendStats; inStock: Set<string> }[] = [];
  for (const topic of topics) {
    if (coveredKeys.has(topic.key)) continue;
    const productIds = await getCollectionProductIds(topic.collectionId);
    const result = await getTrendStatsForShopifyProductIds(
      { aosomCategory: topic.key, shopifyCollectionId: topic.collectionId, shopifyCollectionTitle: topic.title },
      productIds,
    );
    if (!result || result.stats.inStockCount < MIN_IN_STOCK) {
      skipped.push({ key: topic.key, title: topic.title, reason: `moins de ${MIN_IN_STOCK} produits en stock (${result?.stats.inStockCount ?? 0})` });
      continue;
    }
    eligible.push({ topic, stats: result.stats, inStock: new Set(result.inStockIds) });
  }

  eligible.sort(
    (a, b) =>
      Number(isInSeason(b.topic, now)) - Number(isInSeason(a.topic, now)) ||
      b.stats.blendedScore - a.stats.blendedScore ||
      b.stats.inStockCount - a.stats.inStockCount,
  );

  const candidates: CollectionCandidate[] = [];
  let remainingEligible = 0;
  for (const e of eligible) {
    const duplicateOf = coveringSets.find((s) => isNearDuplicate(e.inStock, s));
    if (duplicateOf) {
      skipped.push({ key: e.topic.key, title: e.topic.title, reason: "quasi-doublon d'un guide existant (≥ 80 % des mêmes produits)" });
      continue;
    }
    remainingEligible++;
    // Accepted topics also cover later ones in this same run (two near-identical collections
    // never both get a page), and count as remaining until actually generated.
    coveringSets.push(e.inStock);
    if (candidates.length < count) candidates.push({ stats: e.stats, collectionHandle: e.topic.handle });
  }

  return { candidates, remainingEligible, skipped };
}

/** Current stats of an existing collection-topic guide (for revision passes). */
export async function getCollectionTopicStats(key: string): Promise<{ stats: SubcategoryTrendStats; collectionHandle: string } | null> {
  const handle = key.slice(COLLECTION_TOPIC_PREFIX.length);
  const topic = (await listCollectionTopics()).find((t) => t.handle === handle);
  if (!topic) return null;
  const result = await getTrendStatsForShopifyProductIds(
    { aosomCategory: topic.key, shopifyCollectionId: topic.collectionId, shopifyCollectionTitle: topic.title },
    await getCollectionProductIds(topic.collectionId),
  );
  return result ? { stats: result.stats, collectionHandle: topic.handle } : null;
}
