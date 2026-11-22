/**
 * Nightly candidate catalogue for the offre de remerciement.
 *
 * Every ACTIVE product published on the Online Store, joined with today's cost and stock:
 *   - Aosom: cost = feed wholesale + delivery, stock and colour from today's feed, photo checked (Turso products)
 *            and no open image-review row;
 *   - Costway: cost = costOf(feed price), stock = ca_qty > 0 (or in_stock with qty > 0), colour from costway_products.
 * A variant is kept only if it has a photo and can afford a tier (10 % or 5 % — see discountTier). Unknown cost → out.
 * Costs move intra-day (2026-11-09), so this runs daily after the price sync and never uses a static list.
 */
import { shopifyFetch, parseLinkHeader } from "@/lib/shopify-client";
import { ensureSchema } from "@/lib/database";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { costOf } from "@/lib/costway/pricing";
import { isInternalProduct } from "@/lib/internal-product";
import { discountTier, normalizeType, MIN_CANDIDATE_PRICE, type MerciCandidate } from "./offer-rules";

export interface ShopProduct {
  id: number;
  handle: string;
  title: string;
  product_type: string;
  tags: string;
  status: string;
  published_at: string | null;
  image: { src: string } | null;
  variants: Array<{ id: number; sku: string; price: string; compare_at_price: string | null }>;
}

export interface SupplierInfo {
  cost: number;
  inStock: boolean;
  colour: string | null;
  photoOk: boolean;
}

/** Pure join: Shopify products × supplier info → eligible candidates. */
export function buildCandidates(products: ShopProduct[], supplier: (sku: string, source: "aosom" | "costway") => SupplierInfo | null): MerciCandidate[] {
  const out: MerciCandidate[] = [];
  for (const p of products) {
    if (p.status !== "active" || !p.published_at || !p.image?.src) continue;
    if (isInternalProduct(p)) continue;
    const source = p.tags.split(",").map((t) => t.trim()).includes("src-c") ? "costway" : "aosom";
    for (const v of p.variants) {
      if (!v.sku) continue;
      const info = supplier(v.sku, source);
      if (!info || !info.inStock || !info.photoOk) continue;
      const price = Number(v.price);
      if (!(price >= MIN_CANDIDATE_PRICE)) continue;
      const pct = discountTier(price, info.cost);
      if (!pct) continue;
      const compareAt = v.compare_at_price != null && Number(v.compare_at_price) > price ? Number(v.compare_at_price) : null;
      out.push({
        variantId: String(v.id),
        productId: String(p.id),
        handle: p.handle,
        title: p.title,
        type: normalizeType(p.product_type),
        colour: info.colour,
        price,
        compareAt,
        cost: info.cost,
        imageUrl: p.image.src,
        pct,
      });
    }
  }
  return out;
}

async function loadActiveProducts(): Promise<ShopProduct[]> {
  const out: ShopProduct[] = [];
  let pageInfo: string | null = null;
  for (let i = 0; i < 100; i++) {
    const params = new URLSearchParams({ limit: "250", fields: "id,handle,title,product_type,tags,status,published_at,image,variants" });
    if (pageInfo) params.set("page_info", pageInfo);
    else params.set("status", "active");
    const res = await shopifyFetch(`/products.json?${params}`);
    if (!res.ok) throw new Error(`merci-catalog: products fetch failed ${res.status}`);
    const data = (await res.json()) as { products: ShopProduct[] };
    out.push(...data.products);
    pageInfo = parseLinkHeader(res.headers.get("Link"));
    if (!pageInfo) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

async function loadSupplierInfo(): Promise<(sku: string, source: "aosom" | "costway") => SupplierInfo | null> {
  const feed = new Map<string, { cost?: number; qty: number; color: string }>();
  for (const p of await fetchAosomCatalog()) feed.set(p.sku, { cost: p.cost, qty: p.qty, color: p.color });

  const db = await ensureSchema();
  const checked = new Set<string>();
  const r1 = await db.execute(`SELECT sku FROM products WHERE image_checked_at IS NOT NULL`);
  for (const row of r1.rows) checked.add(String(row.sku));
  const underReview = new Set<string>();
  const r2 = await db.execute(`SELECT sku FROM image_review_queue WHERE status IN ('pending', 'approved')`);
  for (const row of r2.rows) underReview.add(String(row.sku));

  const costway = new Map<string, SupplierInfo>();
  const r3 = await db.execute(`SELECT internal_sku, price, color, in_stock, qty, ca_qty FROM costway_products WHERE internal_sku IS NOT NULL AND removed_at IS NULL`);
  for (const row of r3.rows) {
    const price = Number(row.price);
    if (!(price > 0)) continue;
    const ca = row.ca_qty == null ? null : Number(row.ca_qty);
    const inStock = ca != null ? ca > 0 : Number(row.in_stock) === 1 && Number(row.qty) > 0;
    costway.set(String(row.internal_sku), { cost: costOf(price), inStock, colour: row.color == null ? null : String(row.color), photoOk: true });
  }

  return (sku, source) => {
    if (source === "costway") return costway.get(sku) ?? null;
    const f = feed.get(sku);
    if (!f || typeof f.cost !== "number" || !(f.cost > 0)) return null;
    return { cost: f.cost, inStock: f.qty > 0, colour: f.color || null, photoOk: checked.has(sku) && !underReview.has(sku) };
  };
}

/** Build today's candidate catalogue from live data (read-only). */
export async function buildMerciCatalogue(): Promise<{ products: number; candidates: MerciCandidate[] }> {
  const [products, supplier] = await Promise.all([loadActiveProducts(), loadSupplierInfo()]);
  return { products: products.length, candidates: buildCandidates(products, supplier) };
}
