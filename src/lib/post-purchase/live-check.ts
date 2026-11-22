/**
 * Offre de remerciement — re-check the chosen candidates LIVE before any code is created.
 *
 * The catalogue is rebuilt twice a day (after the 10:30 and 18:00 UTC feed refreshes) with today's Aosom cost; prices,
 * publication and stock can move in between. At offer time, for a handful of candidates (and up to 2 sibling variants
 * of each, used when the chosen variant fails):
 *   - Shopify, live: variant price + compare-at, product ACTIVE and published on the Online Store, variant title/photo;
 *   - stock and cost from Turso rows by SKU only (Aosom `products.qty`, kept fresh by the sync, with the catalogue's
 *     cost; Costway `costway_products` row) — the request path NEVER downloads the Aosom feed;
 *   - the tier is recomputed with the same max(8 $, 8 %) floor, and the price cap re-applied.
 * Every external call has a hard timeout; anything failing or slow means no offer (fail closed).
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { ensureSchema } from "@/lib/database";
import { costOf } from "@/lib/costway/pricing";
import { discountTier, discountedPrice, MIN_CANDIDATE_PRICE, type MerciCandidate, type MerciPick } from "./offer-rules";
import { variantDisplayTitle } from "./catalog";

/** How many ranked products are re-checked at most (one Shopify call, ≤ 2 Turso reads). */
export const MAX_LIVE_CHECK = 8;
/** Hard ceiling for each external call made while answering the Thank you page. */
export const CALL_TIMEOUT_MS = 6_000;

/** Reject after `ms` — the caller treats it like any failure (no offer). */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[merci] timeout after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

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

/**
 * Pure: apply live data to ranked candidates; keeps the ones that still pass, in the same order. When the chosen
 * variant fails, its siblings are tried in order and the first that passes takes its place.
 */
export function applyLive(
  ranked: MerciPick[],
  cap: number,
  live: ReadonlyMap<string, LiveVariant>,
  supply: (c: Pick<MerciCandidate, "sku" | "source" | "cost">) => LiveSupply | null,
): MerciPick[] {
  const out: MerciPick[] = [];
  for (const c of ranked) {
    for (const v of [c, ...(c.siblings ?? [])]) {
      const ok = check(v, cap, live, supply);
      if (!ok) continue;
      const { siblings, ...base } = c;
      void siblings;
      out.push({ ...base, ...ok });
      break;
    }
  }
  return out;
}

function check(
  c: MerciCandidate,
  cap: number,
  live: ReadonlyMap<string, LiveVariant>,
  supply: (c: Pick<MerciCandidate, "sku" | "source" | "cost">) => LiveSupply | null,
): (MerciCandidate & { discountedPrice: number }) | null {
  const v = live.get(c.variantId);
  if (!v || !v.active || !v.published) return null;
  if (!(v.price >= MIN_CANDIDATE_PRICE) || v.price > cap) return null;
  const s = supply(c);
  if (!s || !s.inStock) return null;
  const pct = discountTier(v.price, s.cost);
  if (!pct) return null;
  return {
    ...c,
    title: v.title || c.title,
    imageUrl: v.imageUrl || c.imageUrl,
    price: v.price,
    compareAt: v.compareAt != null && v.compareAt > v.price ? v.compareAt : null,
    cost: s.cost,
    pct,
    discountedPrice: discountedPrice(v.price, pct),
  };
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

/** Aosom stock by SKU from Turso (the sync keeps `products.qty` fresh). Cost stays the catalogue's (feed of the day). */
export async function aosomStock(skus: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!skus.length) return map;
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT sku, qty FROM products WHERE sku IN (${skus.map(() => "?").join(", ")})`, args: skus });
  for (const row of r.rows) map.set(String(row.sku), Number(row.qty));
  return map;
}

/** Costway cost and stock by internal SKU from its table (the Costway sync keeps it fresh). */
export async function costwaySupply(skus: string[]): Promise<Map<string, LiveSupply>> {
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

/** Supply lookup from the two Turso maps: Aosom = catalogue cost + fresh qty; Costway = its row. */
export function supplyFrom(stock: ReadonlyMap<string, number>, costway: ReadonlyMap<string, LiveSupply>) {
  return (c: Pick<MerciCandidate, "sku" | "source" | "cost">): LiveSupply | null => {
    if (c.source === "costway") return costway.get(c.sku) ?? null;
    const qty = stock.get(c.sku);
    return qty == null ? null : { cost: c.cost, inStock: qty > 0 };
  };
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

/** Re-check the best candidates (see liveCheckSet) and their siblings against live Shopify and Turso stock/cost. */
export async function verifyLive(ranked: MerciPick[], cap: number): Promise<MerciPick[]> {
  const head = liveCheckSet(ranked);
  if (!head.length) return [];
  const all: MerciCandidate[] = head.flatMap((c) => [c, ...(c.siblings ?? [])]);
  const [live, stock, costway] = await Promise.all([
    withTimeout(fetchLiveVariants(all.map((c) => c.variantId)), CALL_TIMEOUT_MS, "shopify live variants"),
    withTimeout(aosomStock(all.filter((c) => c.source === "aosom").map((c) => c.sku)), CALL_TIMEOUT_MS, "turso aosom stock"),
    withTimeout(costwaySupply(all.filter((c) => c.source === "costway").map((c) => c.sku)), CALL_TIMEOUT_MS, "turso costway supply"),
  ]);
  return applyLive(head, cap, live, supplyFrom(stock, costway));
}
