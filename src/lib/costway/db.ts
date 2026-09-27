/**
 * Costway catalogue persistence (table `costway_products`, schema in database.ts).
 * Kept out of database.ts on purpose: the Costway catalogue is independent of the Aosom
 * `products` table and nothing in the Aosom pipeline imports this module.
 */
import type { InStatement } from "@libsql/client";
import { ensureSchema } from "@/lib/database";

/** Per-SKU state the sync needs to decide what to write. */
export interface CostwayIndexRow {
  contentHash: string;
  inStock: boolean;
  qty: number;
  usQty: number | null;
  caQty: number | null;
  price: number | null;
  priceDrop: number | null;
  compareAtPrice: number | null;
  promoTag: string;
  removed: boolean;
}

export interface CostwayFullRow {
  sku: string;
  itemNo: string;
  handle: string;
  title: string;
  bodyHtml: string;
  category: string;
  topCategory: string;
  productType: string;
  color: string;
  productUrl: string;
  images: string[];
  inStock: boolean;
  qty: number;
  usQty: number | null;
  caQty: number | null;
  price: number | null;
  priceDrop: number | null;
  compareAtPrice: number | null;
  promoTag: string;
  contentHash: string;
}

export type CostwayVolatile = Pick<
  CostwayFullRow,
  "sku" | "inStock" | "qty" | "usQty" | "caQty" | "price" | "priceDrop" | "compareAtPrice" | "promoTag"
>;

/**
 * Full rows carry ~3 KB of HTML each; 400 keeps a batch around 1.5 MB, well under the
 * Turso request cap (~8 MB). Volatile updates are tiny, so they batch wider.
 */
const FULL_BATCH = 400;
const LIGHT_BATCH = 1000;

export async function getCostwayIndex(): Promise<Map<string, CostwayIndexRow>> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT sku, content_hash, in_stock, qty, us_qty, ca_qty, price, price_drop, compare_at_price, promo_tag, removed_at
       FROM costway_products`,
  );
  const map = new Map<string, CostwayIndexRow>();
  for (const r of res.rows) {
    map.set(String(r.sku), {
      contentHash: String(r.content_hash),
      inStock: Number(r.in_stock) === 1,
      qty: Number(r.qty ?? 0),
      usQty: r.us_qty === null ? null : Number(r.us_qty),
      caQty: r.ca_qty === null ? null : Number(r.ca_qty),
      price: r.price === null ? null : Number(r.price),
      priceDrop: r.price_drop === null ? null : Number(r.price_drop),
      compareAtPrice: r.compare_at_price === null ? null : Number(r.compare_at_price),
      promoTag: String(r.promo_tag ?? ""),
      removed: r.removed_at !== null,
    });
  }
  return map;
}

async function runInBatches(stmts: InStatement[], size: number): Promise<void> {
  const db = await ensureSchema();
  for (let i = 0; i < stmts.length; i += size) {
    await db.batch(stmts.slice(i, i + size), "write");
  }
}

/** Insert new SKUs / rewrite SKUs whose content changed (also clears removed_at). */
export async function upsertCostwayFull(rows: CostwayFullRow[], now: number): Promise<void> {
  const stmts: InStatement[] = rows.map((r) => ({
    sql: `INSERT INTO costway_products (
            sku, item_no, handle, title, body_html, category, top_category, product_type, color,
            product_url, images, in_stock, qty, us_qty, ca_qty, price, price_drop, compare_at_price,
            promo_tag, content_hash, first_seen_at, updated_at, removed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(sku) DO UPDATE SET
            item_no=excluded.item_no, handle=excluded.handle, title=excluded.title,
            body_html=excluded.body_html, category=excluded.category, top_category=excluded.top_category,
            product_type=excluded.product_type, color=excluded.color, product_url=excluded.product_url,
            images=excluded.images, in_stock=excluded.in_stock, qty=excluded.qty, us_qty=excluded.us_qty,
            ca_qty=excluded.ca_qty, price=excluded.price, price_drop=excluded.price_drop,
            compare_at_price=excluded.compare_at_price, promo_tag=excluded.promo_tag,
            content_hash=excluded.content_hash, updated_at=excluded.updated_at, removed_at=NULL`,
    args: [
      r.sku, r.itemNo, r.handle, r.title, r.bodyHtml, r.category, r.topCategory, r.productType, r.color,
      r.productUrl, JSON.stringify(r.images), r.inStock ? 1 : 0, r.qty, r.usQty, r.caQty, r.price,
      r.priceDrop, r.compareAtPrice, r.promoTag, r.contentHash, now, now,
    ],
  }));
  await runInBatches(stmts, FULL_BATCH);
}

/** Stock/price-only changes (and SKUs coming back to the feed with unchanged content). */
export async function updateCostwayVolatile(rows: CostwayVolatile[], now: number): Promise<void> {
  const stmts: InStatement[] = rows.map((r) => ({
    sql: `UPDATE costway_products SET in_stock=?, qty=?, us_qty=?, ca_qty=?, price=?, price_drop=?,
            compare_at_price=?, promo_tag=?, updated_at=?, removed_at=NULL WHERE sku=?`,
    args: [
      r.inStock ? 1 : 0, r.qty, r.usQty, r.caQty, r.price, r.priceDrop, r.compareAtPrice, r.promoTag, now, r.sku,
    ],
  }));
  await runInBatches(stmts, LIGHT_BATCH);
}

/** SKUs that left the feed: flag removed + out of stock, keep the row for history. */
export async function markCostwayRemoved(skus: string[], now: number): Promise<void> {
  const stmts: InStatement[] = skus.map((sku) => ({
    sql: `UPDATE costway_products SET removed_at=?, in_stock=0, updated_at=? WHERE sku=? AND removed_at IS NULL`,
    args: [now, now, sku],
  }));
  await runInBatches(stmts, LIGHT_BATCH);
}

// ─── Catalogue browsing (grouped per product = Item No) ─────────────────────

export interface CostwayCatalogFilters {
  search?: string;
  topCategory?: string;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  promoTag?: string;
  sort?: string;
  page: number;
  limit: number;
}

export interface CostwayCatalogProduct {
  item_no: string;
  title: string;
  category: string;
  top_category: string;
  image: string | null;
  product_url: string | null;
  variants: number;
  in_stock_variants: number;
  qty: number;
  min_price: number | null;
  max_price: number | null;
  price_drop: number | null;
  compare_at_price: number | null;
  colors: string | null;
  promo_tags: string | null;
  first_seen_at: number;
}

const SORTS: Record<string, string> = {
  price_asc: "min_price ASC",
  price_desc: "max_price DESC",
  title: "title ASC",
  stock: "qty DESC",
  newest: "first_seen_at DESC",
};

export async function getCostwayCatalog(
  f: CostwayCatalogFilters,
): Promise<{ products: CostwayCatalogProduct[]; total: number }> {
  const db = await ensureSchema();
  const where: string[] = ["removed_at IS NULL"];
  const having: string[] = [];
  const args: (string | number)[] = [];
  const havingArgs: (string | number)[] = [];

  if (f.search) {
    where.push(`(title LIKE ? OR item_no = ? OR sku = ?)`);
    args.push(`%${f.search}%`, f.search, f.search);
  }
  if (f.topCategory) {
    where.push(`top_category = ?`);
    args.push(f.topCategory);
  }
  if (f.promoTag) {
    where.push(`promo_tag = ?`);
    args.push(f.promoTag);
  }
  if (f.inStock) having.push(`SUM(in_stock) > 0`);
  if (f.minPrice !== undefined && Number.isFinite(f.minPrice)) {
    having.push(`MIN(price) >= ?`);
    havingArgs.push(f.minPrice);
  }
  if (f.maxPrice !== undefined && Number.isFinite(f.maxPrice)) {
    having.push(`MIN(price) <= ?`);
    havingArgs.push(f.maxPrice);
  }

  const grouped = `
    SELECT item_no,
           MIN(title) AS title,
           MIN(category) AS category,
           MIN(top_category) AS top_category,
           MIN(json_extract(images, '$[0]')) AS image,
           MIN(product_url) AS product_url,
           COUNT(*) AS variants,
           SUM(in_stock) AS in_stock_variants,
           SUM(CASE WHEN in_stock = 1 THEN qty ELSE 0 END) AS qty,
           MIN(price) AS min_price,
           MAX(price) AS max_price,
           MAX(price_drop) AS price_drop,
           MAX(compare_at_price) AS compare_at_price,
           GROUP_CONCAT(DISTINCT NULLIF(color, '')) AS colors,
           GROUP_CONCAT(DISTINCT NULLIF(promo_tag, '')) AS promo_tags,
           MIN(first_seen_at) AS first_seen_at
      FROM costway_products
     WHERE ${where.join(" AND ")}
     GROUP BY item_no
     ${having.length ? `HAVING ${having.join(" AND ")}` : ""}`;

  const order = SORTS[f.sort ?? ""] ?? "in_stock_variants > 0 DESC, qty DESC";
  const offset = (f.page - 1) * f.limit;
  const [rows, count] = await Promise.all([
    db.execute({
      sql: `${grouped} ORDER BY ${order}, item_no LIMIT ? OFFSET ?`,
      args: [...args, ...havingArgs, f.limit, offset],
    }),
    db.execute({ sql: `SELECT COUNT(*) AS n FROM (${grouped})`, args: [...args, ...havingArgs] }),
  ]);

  const products = rows.rows.map((r) => ({
    item_no: String(r.item_no),
    title: String(r.title),
    category: String(r.category ?? ""),
    top_category: String(r.top_category ?? ""),
    image: r.image === null ? null : String(r.image),
    product_url: r.product_url === null ? null : String(r.product_url),
    variants: Number(r.variants),
    in_stock_variants: Number(r.in_stock_variants ?? 0),
    qty: Number(r.qty ?? 0),
    min_price: r.min_price === null ? null : Number(r.min_price),
    max_price: r.max_price === null ? null : Number(r.max_price),
    price_drop: r.price_drop === null ? null : Number(r.price_drop),
    compare_at_price: r.compare_at_price === null ? null : Number(r.compare_at_price),
    colors: r.colors === null ? null : String(r.colors),
    promo_tags: r.promo_tags === null ? null : String(r.promo_tags),
    first_seen_at: Number(r.first_seen_at ?? 0),
  }));
  return { products, total: Number(count.rows[0]?.n ?? 0) };
}

export interface CostwaySummary {
  products: number;
  inStockProducts: number;
  variants: number;
  inStockVariants: number;
  categories: { category: string; products: number }[];
  promoTags: { tag: string; variants: number }[];
}

export async function getCostwaySummary(): Promise<CostwaySummary> {
  const db = await ensureSchema();
  const [totals, cats, tags] = await Promise.all([
    db.execute(`
      SELECT COUNT(DISTINCT item_no) AS products,
             COUNT(DISTINCT CASE WHEN in_stock = 1 THEN item_no END) AS in_stock_products,
             COUNT(*) AS variants,
             SUM(in_stock) AS in_stock_variants
        FROM costway_products WHERE removed_at IS NULL`),
    db.execute(`
      SELECT top_category AS category, COUNT(DISTINCT item_no) AS products
        FROM costway_products WHERE removed_at IS NULL AND COALESCE(top_category, '') <> ''
       GROUP BY top_category ORDER BY products DESC`),
    db.execute(`
      SELECT promo_tag AS tag, COUNT(*) AS variants
        FROM costway_products WHERE removed_at IS NULL AND COALESCE(promo_tag, '') <> ''
       GROUP BY promo_tag ORDER BY variants DESC`),
  ]);
  const t = totals.rows[0] ?? {};
  return {
    products: Number(t.products ?? 0),
    inStockProducts: Number(t.in_stock_products ?? 0),
    variants: Number(t.variants ?? 0),
    inStockVariants: Number(t.in_stock_variants ?? 0),
    categories: cats.rows.map((r) => ({ category: String(r.category), products: Number(r.products) })),
    promoTags: tags.rows.map((r) => ({ tag: String(r.tag), variants: Number(r.variants) })),
  };
}
