/**
 * Costway catalogue persistence (table `costway_products`, schema in database.ts).
 * Kept out of database.ts on purpose: the Costway catalogue is independent of the Aosom
 * `products` table and nothing in the Aosom pipeline imports this module.
 */
import type { InStatement } from "@libsql/client";
import { ensureSchema } from "@/lib/database";
import { costOf, marginOf } from "@/lib/costway/pricing";

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
  /** 'only' = products already imported to Shopify, 'exclude' = not yet imported, 'all'/undefined = both. */
  imported?: "only" | "exclude" | "all";
  /** Import batch label ("pilot-1"…). */
  batch?: string;
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
  /** True once at least one variant carries a Shopify product id (see importer.ts). */
  imported: boolean;
  shopify_product_id: string | null;
  shopify_handle: string | null;
  import_batch: string | null;
  import_status: string | null;
  /** Average price we put on Shopify across the imported variants. */
  sell_price: number | null;
  /** Gross margin on the imported variants (before payment fees / returns), % of the sell price. */
  margin_pct: number | null;
  margin_dollars: number | null;
  imported_at: number | null;
}

const IMPORTED_SQL = "(shopify_product_id IS NOT NULL AND TRIM(shopify_product_id) <> '')";

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
  if (f.imported === "only") where.push(IMPORTED_SQL);
  else if (f.imported === "exclude") where.push(`NOT ${IMPORTED_SQL}`);
  if (f.batch) {
    where.push(`import_batch = ?`);
    args.push(f.batch);
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
           MIN(first_seen_at) AS first_seen_at,
           MAX(CASE WHEN ${IMPORTED_SQL} THEN shopify_product_id END) AS shopify_product_id,
           MAX(shopify_handle) AS shopify_handle,
           MAX(import_batch) AS import_batch,
           MAX(import_status) AS import_status,
           MAX(imported_at) AS imported_at,
           AVG(sell_price) AS sell_avg,
           AVG(CASE WHEN sell_price IS NOT NULL THEN price END) AS feed_avg
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
    ...importedFields(r),
  }));
  return { products, total: Number(count.rows[0]?.n ?? 0) };
}

type Row = Record<string, unknown>;

/** The import-tracking part of a grouped catalogue row. */
function importedFields(
  r: Row,
): Pick<
  CostwayCatalogProduct,
  | "imported" | "shopify_product_id" | "shopify_handle" | "import_batch" | "import_status"
  | "sell_price" | "margin_pct" | "margin_dollars" | "imported_at"
> {
  const productId = r.shopify_product_id === null || r.shopify_product_id === undefined ? null : String(r.shopify_product_id);
  const sell = r.sell_avg === null || r.sell_avg === undefined ? null : Number(r.sell_avg);
  const feed = r.feed_avg === null || r.feed_avg === undefined ? null : Number(r.feed_avg);
  const margin = sell !== null && feed !== null && feed > 0 ? marginOf(sell, feed) : null;
  return {
    imported: productId !== null,
    shopify_product_id: productId,
    shopify_handle: r.shopify_handle ? String(r.shopify_handle) : null,
    import_batch: r.import_batch ? String(r.import_batch) : null,
    import_status: r.import_status ? String(r.import_status) : null,
    sell_price: sell === null ? null : Math.round(sell * 100) / 100,
    margin_pct: margin ? margin.pct : null,
    margin_dollars: margin ? margin.dollars : null,
    imported_at: r.imported_at === null || r.imported_at === undefined ? null : Number(r.imported_at),
  };
}

// ─── Order lookup (internal SKU from a Shopify order → what to order at costway.ca) ─────────

export interface CostwayLookupHit {
  internal_sku: string | null;
  /** The supplier variant SKU — what Mat searches on costway.ca. Internal use only. */
  supplier_sku: string;
  item_no: string;
  title: string;
  color: string;
  /** The stored dropship URL, UTM parameters included. */
  product_url: string;
  feed_price: number | null;
  /** Our cost: feed price less the dropship discount. */
  cost: number | null;
  sell_price: number | null;
  margin_dollars: number | null;
  margin_pct: number | null;
  in_stock: boolean;
  qty: number;
  ca_qty: number | null;
  us_qty: number | null;
  removed: boolean;
  imported: boolean;
  shopify_product_id: string | null;
  shopify_handle: string | null;
  import_status: string | null;
  import_batch: string | null;
}

/**
 * Resolve an internal SKU (`M…`, as printed on a Shopify order), a Costway variant SKU or an item
 * number to the variant(s) to order. Exact matches only — a partial SKU must never pick a
 * different product by accident. Returns [] for an empty or unknown query.
 */
export async function lookupVariant(query: string): Promise<CostwayLookupHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  const db = await ensureSchema();
  const res = await db.execute({
    sql: `SELECT internal_sku, sku, item_no, title, color, product_url, price, sell_price, in_stock, qty, ca_qty, us_qty,
                 removed_at, shopify_product_id, shopify_handle, import_status, import_batch
            FROM costway_products
           WHERE internal_sku = ? OR sku = ? OR item_no = ?
           ORDER BY item_no, sku LIMIT 50`,
    args: [q.toUpperCase(), q, q],
  });
  return res.rows.map((r) => {
    const feed = r.price === null ? null : Number(r.price);
    const sell = r.sell_price === null ? null : Number(r.sell_price);
    const margin = sell !== null && feed !== null && feed > 0 ? marginOf(sell, feed) : null;
    const productId = r.shopify_product_id ? String(r.shopify_product_id) : null;
    return {
      internal_sku: r.internal_sku ? String(r.internal_sku) : null,
      supplier_sku: String(r.sku),
      item_no: String(r.item_no),
      title: String(r.title),
      color: String(r.color ?? ""),
      product_url: String(r.product_url ?? ""),
      feed_price: feed,
      cost: feed !== null && feed > 0 ? costOf(feed) : null,
      sell_price: sell,
      margin_dollars: margin ? margin.dollars : null,
      margin_pct: margin ? margin.pct : null,
      in_stock: Number(r.in_stock) === 1,
      qty: Number(r.qty ?? 0),
      ca_qty: r.ca_qty === null ? null : Number(r.ca_qty),
      us_qty: r.us_qty === null ? null : Number(r.us_qty),
      removed: r.removed_at !== null,
      imported: productId !== null,
      shopify_product_id: productId,
      shopify_handle: r.shopify_handle ? String(r.shopify_handle) : null,
      import_status: r.import_status ? String(r.import_status) : null,
      import_batch: r.import_batch ? String(r.import_batch) : null,
    };
  });
}

// ─── Import tracking summary ────────────────────────────────────────────────

export interface CostwayImportSummary {
  importedProducts: number;
  importedVariants: number;
  byStatus: { status: string; products: number; variants: number }[];
  byBatch: { batch: string; products: number; variants: number; importedAt: number | null }[];
  /** Σ (sell price − cost) over imported variants, as if each sold once — a sizing figure, not revenue. */
  estimatedMarginPerSale: number;
}

export async function getImportSummary(): Promise<CostwayImportSummary> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT item_no, price, sell_price, import_status, import_batch, imported_at
       FROM costway_products WHERE ${IMPORTED_SQL}`,
  );
  const products = new Set<string>();
  const status = new Map<string, { products: Set<string>; variants: number }>();
  const batch = new Map<string, { products: Set<string>; variants: number; at: number | null }>();
  let margin = 0;
  for (const r of res.rows) {
    const item = String(r.item_no);
    products.add(item);
    const st = String(r.import_status ?? "inconnu");
    const sb = status.get(st) ?? { products: new Set<string>(), variants: 0 };
    sb.products.add(item);
    sb.variants++;
    status.set(st, sb);
    const bt = String(r.import_batch ?? "sans lot");
    const bb = batch.get(bt) ?? { products: new Set<string>(), variants: 0, at: null };
    bb.products.add(item);
    bb.variants++;
    const at = r.imported_at === null ? null : Number(r.imported_at);
    if (at !== null && (bb.at === null || at > bb.at)) bb.at = at;
    batch.set(bt, bb);
    if (r.sell_price !== null && r.price !== null && Number(r.price) > 0) {
      margin += marginOf(Number(r.sell_price), Number(r.price)).dollars;
    }
  }
  return {
    importedProducts: products.size,
    importedVariants: res.rows.length,
    byStatus: [...status.entries()].map(([s, v]) => ({ status: s, products: v.products.size, variants: v.variants })),
    byBatch: [...batch.entries()]
      .map(([b, v]) => ({ batch: b, products: v.products.size, variants: v.variants, importedAt: v.at }))
      .sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0)),
    estimatedMarginPerSale: Math.round(margin * 100) / 100,
  };
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
