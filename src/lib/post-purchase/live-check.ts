/**
 * Offre de remerciement — re-check the chosen candidates LIVE before any code is created.
 *
 * The catalogue is built once a day; prices, publication, stock and Aosom costs can move in between (Aosom raised
 * costs intra-day on 2026-11-09). So at offer time, for the best candidates in rank order:
 *   - Shopify, live: variant price + compare-at, product ACTIVE and published on the Online Store, variant title/photo;
 *   - today's cost and stock: Aosom feed (newest Blob/CDN copy, cached in memory 20 min), Costway table row;
 *   - the tier is recomputed with the same max(8 $, 8 %) floor, and the price cap re-applied.
 * A candidate failing any of it is dropped. The price shown is the live Shopify price, i.e. the checkout price.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { ensureSchema } from "@/lib/database";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { costOf } from "@/lib/costway/pricing";
import { discountTier, discountedPrice, MIN_CANDIDATE_PRICE, type MerciPick } from "./offer-rules";
import { variantDisplayTitle } from "./catalog";

/** How many ranked candidates are re-checked at most (one Shopify call, one feed lookup). */
export const MAX_LIVE_CHECK = 8;

export interface LiveVariant {
  variantId: string;
  price: number;
  compareAt: number | null;
  title: string;
  imageUrl: string | null;
  active: boolean;
  published: boolean;
}

export interface LiveSupply {
  cost: number;
  inStock: boolean;
}

/** Pure: apply live data to ranked candidates; keeps the ones that still pass, in the same order. */
export function applyLive(
  ranked: MerciPick[],
  cap: number,
  live: ReadonlyMap<string, LiveVariant>,
  supply: (c: Pick<MerciPick, "sku" | "source">) => LiveSupply | null,
): MerciPick[] {
  const out: MerciPick[] = [];
  for (const c of ranked) {
    const v = live.get(c.variantId);
    if (!v || !v.active || !v.published) continue;
    if (!(v.price >= MIN_CANDIDATE_PRICE) || v.price > cap) continue;
    const s = supply(c);
    if (!s || !s.inStock) continue;
    const pct = discountTier(v.price, s.cost);
    if (!pct) continue;
    out.push({
      ...c,
      title: v.title || c.title,
      imageUrl: v.imageUrl || c.imageUrl,
      price: v.price,
      compareAt: v.compareAt != null && v.compareAt > v.price ? v.compareAt : null,
      cost: s.cost,
      pct,
      discountedPrice: discountedPrice(v.price, pct),
    });
  }
  return out;
}

const LIVE_QUERY = `query merciLive($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on ProductVariant {
      id title price compareAtPrice
      image { url }
      product { title status onlineStoreUrl featuredImage { url } }
    }
  }
}`;

export async function fetchLiveVariants(variantIds: string[]): Promise<Map<string, LiveVariant>> {
  const out = new Map<string, LiveVariant>();
  if (!variantIds.length) return out;
  const ids = variantIds.map((id) => `gid://shopify/ProductVariant/${id}`);
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query: LIVE_QUERY, variables: { ids } }) });
  const j = (await res.json()) as {
    data?: {
      nodes: Array<{
        id?: string; title?: string; price?: string; compareAtPrice?: string | null; image?: { url: string } | null;
        product?: { title: string; status: string; onlineStoreUrl: string | null; featuredImage: { url: string } | null };
      } | null>;
    };
    errors?: unknown;
  };
  if (!res.ok || j.errors) throw new Error(`merci live check failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  for (const n of j.data?.nodes ?? []) {
    if (!n?.id || !n.product) continue;
    out.set(n.id.split("/").pop() as string, {
      variantId: n.id.split("/").pop() as string,
      price: Number(n.price),
      compareAt: n.compareAtPrice != null ? Number(n.compareAtPrice) : null,
      title: variantDisplayTitle(n.product.title, n.title),
      imageUrl: n.image?.url ?? n.product.featuredImage?.url ?? null,
      active: n.product.status === "ACTIVE",
      published: !!n.product.onlineStoreUrl,
    });
  }
  return out;
}

// Aosom feed parsed into sku → cost/qty, kept in memory between requests on a warm instance.
const FEED_TTL_MS = 20 * 60_000;
let feedCache: { at: number; map: Map<string, LiveSupply> } | null = null;

async function aosomSupply(nowMs: number): Promise<Map<string, LiveSupply>> {
  if (feedCache && nowMs - feedCache.at < FEED_TTL_MS) return feedCache.map;
  const map = new Map<string, LiveSupply>();
  for (const p of await fetchAosomCatalog()) {
    if (typeof p.cost === "number" && p.cost > 0) map.set(p.sku, { cost: p.cost, inStock: p.qty > 0 });
  }
  feedCache = { at: nowMs, map };
  return map;
}

/** Test-only: forget the cached feed. */
export function __resetFeedCacheForTests(): void {
  feedCache = null;
}

async function costwaySupply(skus: string[]): Promise<Map<string, LiveSupply>> {
  const map = new Map<string, LiveSupply>();
  if (!skus.length) return map;
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT internal_sku, price, in_stock, qty, ca_qty FROM costway_products WHERE removed_at IS NULL AND internal_sku IN (${skus.map(() => "?").join(", ")})`,
    args: skus,
  });
  for (const row of r.rows) {
    const price = Number(row.price);
    if (!(price > 0)) continue;
    const ca = row.ca_qty == null ? null : Number(row.ca_qty);
    map.set(String(row.internal_sku), { cost: costOf(price), inStock: ca != null ? ca > 0 : Number(row.in_stock) === 1 && Number(row.qty) > 0 });
  }
  return map;
}

/**
 * Which candidates to re-check: the best ones of the top product type AND the best ones of other types, half each,
 * in rank order — so an alternative of another type survives even when the top 8 are all the same type.
 */
export function liveCheckSet<T extends { type: string }>(ranked: T[], max = MAX_LIVE_CHECK): T[] {
  const top = ranked[0]?.type;
  const half = Math.ceil(max / 2);
  let same = 0;
  let other = 0;
  const out: T[] = [];
  for (const c of ranked) {
    if (c.type === top ? same < half : other < max - half) {
      out.push(c);
      if (c.type === top) same++;
      else other++;
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Re-check the best candidates (see liveCheckSet) against live Shopify and today's cost/stock. */
export async function verifyLive(ranked: MerciPick[], cap: number, nowMs = Date.now()): Promise<MerciPick[]> {
  const head = liveCheckSet(ranked);
  if (!head.length) return [];
  const needAosom = head.some((c) => c.source === "aosom");
  const [live, aosom, costway] = await Promise.all([
    fetchLiveVariants(head.map((c) => c.variantId)),
    needAosom ? aosomSupply(nowMs) : Promise.resolve(new Map<string, LiveSupply>()),
    costwaySupply(head.filter((c) => c.source === "costway").map((c) => c.sku)),
  ]);
  return applyLive(head, cap, live, (c) => (c.source === "costway" ? costway.get(c.sku) : aosom.get(c.sku)) ?? null);
}
