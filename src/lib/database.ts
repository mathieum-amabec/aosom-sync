import { createClient, type Client, type Row, type InValue } from "@libsql/client";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { SyncRun, SyncLogEntry, ChangeType } from "@/types/sync";
import type { UserRole } from "@/lib/config";

let client: Client | null = null;

function getDb(): Client {
  if (!client) {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;

    if (tursoUrl && tursoToken) {
      // Production: remote Turso
      client = createClient({ url: tursoUrl, authToken: tursoToken });
    } else if (tursoUrl || tursoToken) {
      // Partial config — one set without the other. Fail loud.
      throw new Error("Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (or neither for local SQLite)");
    } else {
      // Dev/local: SQLite file
      const dbDir = path.join(process.cwd(), "data");
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
      client = createClient({ url: `file:${path.join(dbDir, "aosom-sync.db")}` });
    }
  }
  return client;
}

/** Row → plain object helper. libsql Row objects support property access by column name. */
function rowToObj(row: Row): Record<string, unknown> {
  // libsql Row is iterable and supports named property access
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "length" && !/^\d+$/.test(key))
  );
}

// ─── Schema Initialization ──────────────────────────────────────────

let schemaPromise: Promise<void> | null = null;

export async function initSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = _initSchemaImpl();
  }
  return schemaPromise;
}

async function _initSchemaImpl(): Promise<void> {
  const db = getDb();

  // Schema statements inlined for Vercel compatibility (serverless has no access to src/ files at runtime)
  const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER, color TEXT, size TEXT,
      product_type TEXT, image1 TEXT, image2 TEXT, image3 TEXT, image4 TEXT, image5 TEXT,
      image6 TEXT, image7 TEXT, video TEXT, description TEXT, short_description TEXT,
      material TEXT, gtin TEXT, weight REAL, out_of_stock_expected TEXT, estimated_arrival TEXT,
      shopify_product_id TEXT, shopify_variant_id TEXT, last_seen_at INTEGER, last_posted_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type)`,
    `CREATE INDEX IF NOT EXISTS idx_products_shopify_id ON products(shopify_product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_products_price ON products(price)`,
    `CREATE INDEX IF NOT EXISTS idx_products_qty ON products(qty)`,
    `CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`,
    `CREATE INDEX IF NOT EXISTS idx_products_name_sku ON products(name, sku)`,
    `CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, old_price REAL, new_price REAL,
      old_qty INTEGER, new_qty INTEGER, change_type TEXT,
      detected_at INTEGER DEFAULT (strftime('%s','now')), applied_to_shopify INTEGER DEFAULT 0,
      FOREIGN KEY (sku) REFERENCES products(sku)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_price_history_change_type ON price_history(change_type)`,
    `CREATE INDEX IF NOT EXISTS idx_price_history_detected_at ON price_history(detected_at)`,
    `CREATE TABLE IF NOT EXISTS facebook_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, trigger_type TEXT NOT NULL,
      language TEXT NOT NULL, post_text TEXT NOT NULL, image_path TEXT, image_url TEXT,
      image_urls TEXT,
      old_price REAL, new_price REAL, status TEXT DEFAULT 'draft', scheduled_at INTEGER,
      published_at INTEGER, facebook_post_id TEXT,
      post_text_en TEXT, channels TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (sku) REFERENCES products(sku)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_facebook_drafts_sku ON facebook_drafts(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_facebook_drafts_status ON facebook_drafts(status)`,
    // Migrations for tables created before multi-channel columns existed (no-op if already present)
    `CREATE TABLE IF NOT EXISTS social_autopost_counter (
      day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
      message TEXT NOT NULL, read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)`,
    `CREATE TABLE IF NOT EXISTS product_type_counts (
      type TEXT PRIMARY KEY, count INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS collection_mappings (
      aosom_category TEXT NOT NULL,
      collection_role TEXT NOT NULL DEFAULT 'sub' CHECK(collection_role IN ('main', 'sub')),
      shopify_collection_id TEXT NOT NULL,
      shopify_collection_title TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (aosom_category, collection_role)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'reviewer')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_login_at INTEGER
    )`,
  ];

  // Batch all schema + legacy table creation in a single round trip
  const legacyStatements = [
    `CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_products INTEGER DEFAULT 0, created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0, error_messages TEXT DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY, sync_run_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      shopify_product_id TEXT, sku TEXT NOT NULL, action TEXT NOT NULL,
      field TEXT NOT NULL, old_value TEXT, new_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY, group_key TEXT UNIQUE NOT NULL, product_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', content TEXT, shopify_id TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_logs_run ON sync_logs(sync_run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_logs_sku ON sync_logs(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_runs_date ON sync_runs(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status)`,
  ];

  const allStatements = [...schemaStatements, ...legacyStatements];
  await db.batch(allStatements.map(sql => ({ sql, args: [] })), "write");

  // Column migrations for facebook_drafts (post_text_en, channels) — SQLite can't IF NOT EXISTS on ALTER
  const info = await db.execute(`PRAGMA table_info(facebook_drafts)`);
  const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  const alters: string[] = [];
  if (!cols.has("post_text_en")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN post_text_en TEXT`);
  if (!cols.has("channels")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN channels TEXT`);
  if (!cols.has("image_urls")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN image_urls TEXT`);
  if (alters.length > 0) {
    await db.batch(alters.map(sql => ({ sql, args: [] })), "write");
  }

  // Idempotent users.role migration — ALTER TABLE ADD COLUMN with a default.
  // Existing rows get 'admin' to preserve backwards compatibility for the
  // original AUTH_PASSWORD-seeded admin user.
  const usersInfo = await db.execute(`PRAGMA table_info(users)`);
  const userCols = new Set(usersInfo.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  if (!userCols.has("role")) {
    await db.execute(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
  }
  // Backfill image_urls from legacy single image_url, one-shot idempotent.
  if (!cols.has("image_urls")) {
    await db.execute(
      `UPDATE facebook_drafts SET image_urls = json_array(image_url) WHERE image_urls IS NULL AND image_url IS NOT NULL`
    );
  }

  // Default settings — batch insert
  const defaultSettings: [string, string][] = [
    ['social_default_language', 'FR'],
    ['social_post_frequency', '1'],
    ['social_preferred_hour', '13'],
    ['social_price_drop_threshold', '10'],
    ['social_min_days_between_reposts', '30'],
    ['social_hashtags_fr', '#jardinage #patio #mobilierexterieur #canada'],
    ['social_hashtags_en', '#garden #patio #outdoorfurniture #canada'],
    ['social_include_price', 'true'],
    ['social_include_link', 'true'],
    ['social_tone', 'promotional'],
    ['prompt_new_product_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook engageant pour ce nouveau produit : {product_name}. Prix : {price}$. Ton : enthousiaste et accessible. Maximum 150 mots. Termine avec les hashtags : {hashtags}'],
    ['prompt_new_product_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write an engaging Facebook post for this new product: {product_name}. Price: {price}$. Tone: enthusiastic and approachable. Maximum 150 words. End with hashtags: {hashtags}'],
    ['prompt_price_drop_fr', 'Tu es un expert en marketing promotionnel québécois. Rédige un post Facebook pour annoncer une baisse de prix sur : {product_name}. Ancien prix : {old_price}$. Nouveau prix : {new_price}$. Mets en valeur les économies. Maximum 120 mots. Hashtags : {hashtags}'],
    ['prompt_price_drop_en', 'You are a Canadian promotional marketing expert. Write a Facebook post announcing a price drop on: {product_name}. Old price: {old_price}$. New price: {new_price}$. Highlight the savings. Maximum 120 words. Hashtags: {hashtags}'],
    ['prompt_highlight_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook pour mettre en valeur ce produit populaire de notre catalogue : {product_name}. Prix : {price}$. Stock disponible : {qty} unités. Maximum 130 mots. Hashtags : {hashtags}'],
    ['prompt_highlight_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write a Facebook post highlighting this popular product from our catalogue: {product_name}. Price: {price}$. Stock: {qty} units available. Maximum 130 words. Hashtags: {hashtags}'],
    ['social_accent_color', '#2563eb'],
    ['social_text_color', '#ffffff'],
    ['social_store_display_name', ''],
    ['social_banner_opacity', '75'],
    ['social_logo_position', 'bottom-right'],
  ];

  await db.batch(
    defaultSettings.map(([key, value]) => ({
      sql: `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
      args: [key, value],
    })),
    "write"
  );

  // Enable WAL and foreign keys for local SQLite
  if (!process.env.TURSO_DATABASE_URL) {
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA foreign_keys = ON");
  }

}

/** Ensure schema is initialized before any query */
async function ensureSchema(): Promise<Client> {
  await initSchema();
  return getDb();
}

// ─── Products (replaces catalog_snapshots) ───────────────────────────

export interface ProductRow {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  size: string;
  product_type: string;
  image1: string;
  image2: string;
  image3: string;
  image4: string;
  image5: string;
  image6: string;
  image7: string;
  video: string;
  description: string;
  short_description: string;
  material: string;
  gtin: string;
  weight: number;
  out_of_stock_expected: string;
  estimated_arrival: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  last_seen_at: number;
  last_posted_at: number | null;
  created_at: number;
}

function rowToProduct(row: Row): ProductRow {
  const o = rowToObj(row);
  return {
    sku: (o.sku as string) || "",
    name: (o.name as string) || "",
    price: Number(o.price) || 0,
    qty: Number(o.qty) || 0,
    color: (o.color as string) || "",
    size: (o.size as string) || "",
    product_type: (o.product_type as string) || "",
    image1: (o.image1 as string) || "",
    image2: (o.image2 as string) || "",
    image3: (o.image3 as string) || "",
    image4: (o.image4 as string) || "",
    image5: (o.image5 as string) || "",
    image6: (o.image6 as string) || "",
    image7: (o.image7 as string) || "",
    video: (o.video as string) || "",
    description: (o.description as string) || "",
    short_description: (o.short_description as string) || "",
    material: (o.material as string) || "",
    gtin: (o.gtin as string) || "",
    weight: Number(o.weight) || 0,
    out_of_stock_expected: (o.out_of_stock_expected as string) || "",
    estimated_arrival: (o.estimated_arrival as string) || "",
    shopify_product_id: (o.shopify_product_id as string) || null,
    shopify_variant_id: (o.shopify_variant_id as string) || null,
    last_seen_at: Number(o.last_seen_at) || 0,
    last_posted_at: o.last_posted_at != null ? Number(o.last_posted_at) : null,
    created_at: Number(o.created_at) || 0,
  };
}

export async function refreshProducts(products: Omit<ProductRow, "shopify_product_id" | "shopify_variant_id" | "last_posted_at" | "created_at">[]): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const stmts = products.map((p) => ({
    sql: `INSERT INTO products (sku, name, price, qty, color, size, product_type,
      image1, image2, image3, image4, image5, image6, image7, video,
      description, short_description, material, gtin, weight,
      out_of_stock_expected, estimated_arrival, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      name=excluded.name, price=excluded.price, qty=excluded.qty,
      color=excluded.color, size=excluded.size, product_type=excluded.product_type,
      image1=excluded.image1, image2=excluded.image2, image3=excluded.image3,
      image4=excluded.image4, image5=excluded.image5, image6=excluded.image6,
      image7=excluded.image7, video=excluded.video,
      description=excluded.description, short_description=excluded.short_description,
      material=excluded.material, gtin=excluded.gtin, weight=excluded.weight,
      out_of_stock_expected=excluded.out_of_stock_expected,
      estimated_arrival=excluded.estimated_arrival, last_seen_at=excluded.last_seen_at`,
    args: [
      p.sku, p.name, p.price, p.qty, p.color, p.size, p.product_type,
      p.image1, p.image2, p.image3, p.image4, p.image5, p.image6, p.image7,
      p.video, p.description, p.short_description, p.material, p.gtin, p.weight,
      p.out_of_stock_expected, p.estimated_arrival, now,
    ],
  }));

  // Batch in chunks of 100 (Turso batch limit)
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), "write");
  }
}

export async function getProduct(sku: string): Promise<ProductRow | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM products WHERE sku = ?`, args: [sku] });
  return result.rows.length > 0 ? rowToProduct(result.rows[0]) : null;
}

export async function getAllProductsMap(): Promise<Map<string, ProductRow>> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT * FROM products`);
  const map = new Map<string, ProductRow>();
  for (const row of result.rows) {
    const p = rowToProduct(row);
    map.set(p.sku, p);
  }
  return map;
}

// ─── Product Type Counts (pre-computed table, rebuilt during sync) ──

async function getCachedProductTypes(db: ReturnType<typeof getDb>): Promise<{ type: string; count: number }[]> {
  const result = await db.execute(`SELECT type, count FROM product_type_counts ORDER BY type`);
  if (result.rows.length > 0) {
    return result.rows.map(row => {
      const o = rowToObj(row);
      return { type: o.type as string, count: Number(o.count) || 0 };
    });
  }
  // Fallback: compute and persist if table is empty (first run after migration)
  await rebuildProductTypeCounts();
  const fallback = await db.execute(`SELECT type, count FROM product_type_counts ORDER BY type`);
  return fallback.rows.map(row => {
    const o = rowToObj(row);
    return { type: o.type as string, count: Number(o.count) || 0 };
  });
}

/** Rebuild the product_type_counts table. Called after sync upserts products. */
export async function rebuildProductTypeCounts(): Promise<void> {
  const db = await ensureSchema();
  const typeResult = await db.execute(
    `SELECT product_type, COUNT(*) as cnt FROM products WHERE product_type != '' GROUP BY product_type ORDER BY product_type`
  );
  const typeCounts = new Map<string, number>();
  for (const row of typeResult.rows) {
    const o = rowToObj(row);
    const pt = (o.product_type as string) || "";
    const cnt = Number(o.cnt) || 0;
    const parts = pt.split(">").map((s: string) => s.trim());
    let p = "";
    for (const part of parts) {
      p = p ? `${p} > ${part}` : part;
      typeCounts.set(p, (typeCounts.get(p) || 0) + cnt);
    }
  }
  // Rebuild table
  await db.execute(`DELETE FROM product_type_counts`);
  for (const [type, count] of typeCounts) {
    await db.execute({ sql: `INSERT INTO product_type_counts (type, count) VALUES (?, ?)`, args: [type, count] });
  }
}

export async function getProducts(filters: {
  productType?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  color?: string;
  size?: string;
  page?: number;
  limit?: number;
  sort?: string;
}): Promise<{ products: ProductRow[]; total: number; productTypes: { type: string; count: number }[] }> {
  const db = await ensureSchema();
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filters.productType) { conditions.push(`product_type LIKE ?`); args.push(`${filters.productType}%`); }
  if (filters.search) { conditions.push(`(name LIKE ? OR sku LIKE ?)`); args.push(`%${filters.search}%`, `%${filters.search}%`); }
  if (filters.minPrice !== undefined) { conditions.push(`price >= ?`); args.push(filters.minPrice); }
  if (filters.maxPrice !== undefined) { conditions.push(`price <= ?`); args.push(filters.maxPrice); }
  if (filters.inStock) { conditions.push(`qty > 0`); }
  if (filters.color) { conditions.push(`color = ?`); args.push(filters.color); }
  if (filters.size) { conditions.push(`size = ?`); args.push(filters.size); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(Math.max(1, filters.limit || 50), 200);
  const offset = (page - 1) * limit;

  let orderBy = "name ASC";
  switch (filters.sort) {
    case "price_asc": orderBy = "price ASC"; break;
    case "price_desc": orderBy = "price DESC"; break;
    case "qty_asc": orderBy = "qty ASC"; break;
    case "qty_desc": orderBy = "qty DESC"; break;
    case "name_asc": orderBy = "name ASC"; break;
    case "name_desc": orderBy = "name DESC"; break;
    case "low_stock": orderBy = "CASE WHEN qty > 0 THEN 0 ELSE 1 END, qty ASC"; break;
  }

  // Select only columns the catalog UI needs
  const catalogColumns = "sku, name, price, qty, color, product_type, image1, shopify_product_id";

  // Run count + data in parallel (2 round trips instead of 3)
  const [countResult, productsResult] = await Promise.all([
    db.execute({ sql: `SELECT COUNT(*) as cnt FROM products ${where}`, args }),
    db.execute({
      sql: `SELECT ${catalogColumns} FROM products ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    }),
  ]);

  const total = Number(rowToObj(countResult.rows[0]).cnt) || 0;
  const products = productsResult.rows.map(rowToProduct);

  // Product types: use cached value (refreshed on sync, not on every page load)
  const productTypes = await getCachedProductTypes(db);

  return { products, total, productTypes };
}

// ─── Collection Mappings ────────────────────────────────────────────

export type CollectionRole = "main" | "sub";

export interface CollectionMapping {
  aosomCategory: string;
  collectionRole?: CollectionRole; // optional for back-compat; defaults to 'sub' on upsert
  shopifyCollectionId: string;
  shopifyCollectionTitle: string;
}

function rowToMapping(row: Row): CollectionMapping {
  const o = rowToObj(row);
  return {
    aosomCategory: o.aosom_category as string,
    collectionRole: (o.collection_role as CollectionRole) || "sub",
    shopifyCollectionId: o.shopify_collection_id as string,
    shopifyCollectionTitle: o.shopify_collection_title as string,
  };
}

export async function getAllCollectionMappings(): Promise<CollectionMapping[]> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT aosom_category, collection_role, shopify_collection_id, shopify_collection_title FROM collection_mappings ORDER BY aosom_category, collection_role`,
  );
  return result.rows.map(rowToMapping);
}

/**
 * Infer collection_role from the aosom_category key when the caller doesn't specify one.
 * Level-1 keys (no " > ") represent top-level Aosom categories → main. Level-2+ keys
 * (contain " > ") represent subcategories → sub. This matches the migration seeding
 * logic and keeps the legacy /collections UI (which POSTs without a role field) from
 * polluting the table with bogus sub rows for level-1 keys.
 */
function inferRole(aosomCategory: string, explicit?: CollectionRole): CollectionRole {
  if (explicit) return explicit;
  return aosomCategory.includes(" > ") ? "sub" : "main";
}

export async function upsertCollectionMapping(mapping: CollectionMapping): Promise<void> {
  const db = await ensureSchema();
  const role = inferRole(mapping.aosomCategory, mapping.collectionRole);
  await db.execute({
    sql: `INSERT OR REPLACE INTO collection_mappings (aosom_category, collection_role, shopify_collection_id, shopify_collection_title, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))`,
    args: [mapping.aosomCategory, role, mapping.shopifyCollectionId, mapping.shopifyCollectionTitle],
  });
}

export async function upsertCollectionMappingsBatch(mappings: CollectionMapping[]): Promise<void> {
  const db = await ensureSchema();
  await db.batch(
    mappings.map((m) => ({
      sql: `INSERT OR REPLACE INTO collection_mappings (aosom_category, collection_role, shopify_collection_id, shopify_collection_title, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      args: [m.aosomCategory, inferRole(m.aosomCategory, m.collectionRole), m.shopifyCollectionId, m.shopifyCollectionTitle],
    })),
    "write",
  );
}

export async function deleteCollectionMapping(aosomCategory: string, role?: CollectionRole): Promise<void> {
  const db = await ensureSchema();
  if (role) {
    await db.execute({
      sql: `DELETE FROM collection_mappings WHERE aosom_category = ? AND collection_role = ?`,
      args: [aosomCategory, role],
    });
  } else {
    await db.execute({ sql: `DELETE FROM collection_mappings WHERE aosom_category = ?`, args: [aosomCategory] });
  }
}

/**
 * Look up BOTH the main and sub collections for a product.
 *
 * Lookup order for each role:
 *   1. Exact match on the full productType
 *   2. Walk up the hierarchy (strip trailing " > X" segments) and retry
 *
 * Returns an object with `main` and `sub` fields, each null if no match found.
 */
export async function findCollectionsForProduct(
  productType: string,
): Promise<{ main: CollectionMapping | null; sub: CollectionMapping | null }> {
  const db = await ensureSchema();
  const parts = productType.split(">").map((s) => s.trim()).filter(Boolean);

  async function lookup(role: CollectionRole): Promise<CollectionMapping | null> {
    // Walk from most specific to least specific
    for (let i = parts.length; i >= 1; i--) {
      const category = parts.slice(0, i).join(" > ");
      const result = await db.execute({
        sql: `SELECT * FROM collection_mappings WHERE aosom_category = ? AND collection_role = ?`,
        args: [category, role],
      });
      if (result.rows.length > 0) return rowToMapping(result.rows[0]);
    }
    return null;
  }

  const [main, sub] = await Promise.all([lookup("main"), lookup("sub")]);
  return { main, sub };
}

export async function getProductsWithShopifyId(): Promise<{ sku: string; product_type: string; shopify_product_id: string }[]> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT sku, product_type, shopify_product_id FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`);
  return result.rows.map(row => {
    const o = rowToObj(row);
    return { sku: o.sku as string, product_type: o.product_type as string, shopify_product_id: o.shopify_product_id as string };
  });
}

export async function getProductCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as cnt FROM products`);
  return Number(rowToObj(result.rows[0]).cnt) || 0;
}

export async function getImportedProductCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as cnt FROM products WHERE shopify_product_id IS NOT NULL`);
  return Number(rowToObj(result.rows[0]).cnt) || 0;
}

export async function updateProductShopifyIds(sku: string, shopifyProductId: string, shopifyVariantId: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE products SET shopify_product_id = ?, shopify_variant_id = ? WHERE sku = ?`, args: [shopifyProductId, shopifyVariantId, sku] });
}

// ─── Price History (enriched) ────────────────────────────────────────

export type ChangeTypeHistory = "price_drop" | "price_increase" | "stock_change" | "new_product" | "restock";

export async function recordPriceChange(entry: {
  sku: string; oldPrice: number | null; newPrice: number | null;
  oldQty: number | null; newQty: number | null; changeType: ChangeTypeHistory;
}): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type) VALUES (?, ?, ?, ?, ?, ?)`, args: [entry.sku, entry.oldPrice, entry.newPrice, entry.oldQty, entry.newQty, entry.changeType] });
}

export async function recordPriceChanges(entries: {
  sku: string; oldPrice: number | null; newPrice: number | null;
  oldQty: number | null; newQty: number | null; changeType: ChangeTypeHistory;
}[]): Promise<void> {
  const db = await ensureSchema();
  const stmts = entries.map((e) => ({
    sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [e.sku, e.oldPrice, e.newPrice, e.oldQty, e.newQty, e.changeType],
  }));
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), "write");
  }
}

export async function markPriceChangeApplied(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE price_history SET applied_to_shopify = 1 WHERE id = ?`, args: [id] });
}

export async function getRecentPriceChanges(limit = 50): Promise<Record<string, unknown>[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT ph.*, p.name, p.image1, p.shopify_product_id
    FROM price_history ph LEFT JOIN products p ON ph.sku = p.sku
    ORDER BY ph.detected_at DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map(rowToObj);
}

// ─── Notifications ──────────────────────────────────────────────────

export async function createNotification(type: string, title: string, message: string): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `INSERT INTO notifications (type, title, message) VALUES (?, ?, ?)`, args: [type, title, message] });
  return Number(result.lastInsertRowid);
}

export async function getNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const db = await ensureSchema();
  const where = opts.unreadOnly ? "WHERE read = 0" : "";
  const limit = opts.limit || 50;
  const result = await db.execute({ sql: `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`, args: [limit] });
  return result.rows.map(rowToObj);
}

export async function markNotificationRead(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE notifications SET read = 1 WHERE id = ?`, args: [id] });
}

export async function markAllNotificationsRead(): Promise<void> {
  const db = await ensureSchema();
  await db.execute(`UPDATE notifications SET read = 1 WHERE read = 0`);
}

export async function getUnreadNotificationCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as count FROM notifications WHERE read = 0`);
  return Number(rowToObj(result.rows[0]).count) || 0;
}

// ─── Users ──────────────────────────────────────────────────────────

export type DbUserRole = UserRole;

export async function getUserByUsername(username: string): Promise<{ id: number; username: string; password_hash: string; role: DbUserRole } | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT id, username, password_hash, role FROM users WHERE username = ?`, args: [username] });
  if (result.rows.length === 0) return null;
  const o = rowToObj(result.rows[0]);
  const role = (o.role as string) === "reviewer" ? "reviewer" : "admin";
  return { id: Number(o.id), username: o.username as string, password_hash: o.password_hash as string, role };
}

export async function createUser(username: string, passwordHash: string, role: DbUserRole = "admin"): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, args: [username, passwordHash, role] });
  return Number(result.lastInsertRowid);
}

export async function getUserCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as cnt FROM users`);
  return Number(rowToObj(result.rows[0]).cnt) || 0;
}

export async function updateUserLastLogin(id: number): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({ sql: `UPDATE users SET last_login_at = ? WHERE id = ?`, args: [now, id] });
}

export async function updateUserPassword(id: number, passwordHash: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE users SET password_hash = ? WHERE id = ?`, args: [passwordHash, id] });
}

// ─── Settings ────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [key] });
  if (result.rows.length === 0) return null;
  return (rowToObj(result.rows[0]).value as string) ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({ sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, args: [key, value, now] });
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT key, value FROM settings`);
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    const o = rowToObj(row);
    settings[o.key as string] = o.value as string;
  }
  return settings;
}

// ─── Trending Products ──────────────────────────────────────────────

export interface TrendingProduct {
  sku: string; name: string; price: number; image1: string;
  shopify_product_id: string | null; units_moved: number;
}

export async function getTrendingProducts(limit = 10): Promise<TrendingProduct[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT ph.sku, p.name, p.price, p.image1, p.shopify_product_id,
           SUM(ph.old_qty - ph.new_qty) as units_moved
    FROM price_history ph JOIN products p ON ph.sku = p.sku
    WHERE ph.change_type = 'stock_change'
      AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
      AND ph.old_qty > ph.new_qty
    GROUP BY ph.sku ORDER BY units_moved DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((row) => {
    const o = rowToObj(row);
    return {
      sku: (o.sku as string) || "",
      name: (o.name as string) || "",
      price: Number(o.price) || 0,
      image1: (o.image1 as string) || "",
      shopify_product_id: (o.shopify_product_id as string) || null,
      units_moved: Number(o.units_moved) || 0,
    };
  });
}

// ─── Sync Runs ───────────────────────────────────────────────────────

export async function clearStaleLockIfNeeded(): Promise<void> {
  const db = await ensureSchema();
  await db.execute(`
    UPDATE sync_runs SET status = 'failed', completed_at = datetime('now'),
      error_messages = '["Stale lock cleared (timeout > 30 min)"]'
    WHERE status = 'running' AND datetime(started_at) < datetime('now', '-30 minutes')
  `);
}

export async function createSyncRun(): Promise<SyncRun> {
  const db = await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({ sql: `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`, args: [id, now] });
  return { id, startedAt: now, completedAt: null, status: "running", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 0, errorMessages: [] };
}

export async function completeSyncRun(
  id: string,
  stats: { status: "completed" | "failed"; totalProducts: number; created: number; updated: number; archived: number; errors: number; errorMessages: string[] }
): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE sync_runs SET completed_at=?, status=?, total_products=?, created=?, updated=?, archived=?, errors=?, error_messages=? WHERE id=?`, args: [new Date().toISOString(), stats.status, stats.totalProducts, stats.created, stats.updated, stats.archived, stats.errors, JSON.stringify(stats.errorMessages), id] });
}

export async function getSyncRuns(limit = 20): Promise<SyncRun[]> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`, args: [limit] });
  return result.rows.map((r) => mapSyncRun(rowToObj(r)));
}

export async function getLatestSyncRun(): Promise<SyncRun | null> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1`);
  return result.rows.length > 0 ? mapSyncRun(rowToObj(result.rows[0])) : null;
}

function mapSyncRun(row: Record<string, unknown>): SyncRun {
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) || null,
    status: row.status as SyncRun["status"],
    totalProducts: (row.total_products as number) || 0,
    created: (row.created as number) || 0,
    updated: (row.updated as number) || 0,
    archived: (row.archived as number) || 0,
    errors: (row.errors as number) || 0,
    errorMessages: JSON.parse((row.error_messages as string) || "[]"),
  };
}

// ─── Sync Logs ───────────────────────────────────────────────────────

export async function addSyncLogsBatch(entries: Omit<SyncLogEntry, "id">[]): Promise<void> {
  const db = await ensureSchema();
  const stmts = entries.map((e) => ({
    sql: `INSERT INTO sync_logs (id, sync_run_id, timestamp, shopify_product_id, sku, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), e.syncRunId, e.timestamp, e.shopifyProductId, e.sku, e.action, e.field, e.oldValue, e.newValue],
  }));
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), "write");
  }
}

export async function getSyncLogs(syncRunId: string, limit = 500): Promise<SyncLogEntry[]> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM sync_logs WHERE sync_run_id = ? ORDER BY timestamp DESC LIMIT ?`, args: [syncRunId, limit] });
  return result.rows.map((r) => mapSyncLog(rowToObj(r)));
}

function mapSyncLog(row: Record<string, unknown>): SyncLogEntry {
  return {
    id: row.id as string,
    syncRunId: row.sync_run_id as string,
    timestamp: row.timestamp as string,
    shopifyProductId: (row.shopify_product_id as string) || null,
    sku: row.sku as string,
    action: row.action as SyncLogEntry["action"],
    field: row.field as ChangeType,
    oldValue: (row.old_value as string) || null,
    newValue: (row.new_value as string) || null,
  };
}

// ─── Import Jobs ─────────────────────────────────────────────────────

const IMPORT_JOB_COLUMNS = new Set([
  "status", "content", "shopify_id", "error", "product_data", "group_key",
]);

export async function upsertImportJob(job: { id: string; groupKey: string; productData: string; status: string; createdAt: string; updatedAt: string }): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO import_jobs (id, group_key, product_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_key) DO UPDATE SET product_data=excluded.product_data, status='pending', updated_at=excluded.updated_at`,
    args: [job.id, job.groupKey, job.productData, job.status, job.createdAt, job.updatedAt],
  });
}

export async function getImportJobs(): Promise<Record<string, unknown>[]> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT * FROM import_jobs ORDER BY created_at DESC`);
  return result.rows.map(rowToObj);
}

export async function getImportJob(jobId: string): Promise<Record<string, unknown> | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM import_jobs WHERE id = ?`, args: [jobId] });
  return result.rows.length > 0 ? rowToObj(result.rows[0]) : null;
}

export async function updateImportJob(jobId: string, fields: Record<string, unknown>): Promise<void> {
  const db = await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!IMPORT_JOB_COLUMNS.has(key)) throw new Error(`Invalid column name: ${key}`);
    sets.push(`${key} = ?`);
    args.push(value as InValue);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?`);
  args.push(new Date().toISOString());
  args.push(jobId);
  await db.execute({ sql: `UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

// ─── Facebook Drafts ─────────────────────────────────────────────────

/** Per-channel publish state tracked inside facebook_drafts.channels (JSON). */
export interface ChannelState {
  status: "pending" | "published" | "error" | "skipped";
  publishedId?: string;
  publishedAt?: number;
  error?: string;
}

export interface FacebookDraft {
  id: number; sku: string; triggerType: string; language: string;
  postText: string;
  /** English caption for EN channels (Furnish Facebook, future Furnish IG). Optional for legacy drafts. */
  postTextEn: string | null;
  imagePath: string | null; imageUrl: string | null;
  /** Ordered public image URLs for multi-photo posts. Always ≥1 element when there is any image. */
  imageUrls: string[];
  oldPrice: number | null; newPrice: number | null; status: string;
  scheduledAt: number | null; publishedAt: number | null;
  facebookPostId: string | null;
  /** Per-channel publish state. Keys are CHANNELS values (e.g. "fb_ameublo"). */
  channels: Record<string, ChannelState>;
  createdAt: number;
  productName?: string; productImage?: string;
}

function mapDraft(row: Record<string, unknown>): FacebookDraft {
  let channels: Record<string, ChannelState> = {};
  const raw = row.channels;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      channels = JSON.parse(raw);
    } catch {
      channels = {};
    }
  }
  const imageUrl = (row.image_url as string) || null;
  let imageUrls: string[] = [];
  const rawUrls = row.image_urls;
  if (typeof rawUrls === "string" && rawUrls.length > 0) {
    try {
      const parsed = JSON.parse(rawUrls);
      if (Array.isArray(parsed)) imageUrls = parsed.filter((u): u is string => typeof u === "string" && u.length > 0);
    } catch {
      imageUrls = [];
    }
  }
  // Legacy drafts: fall back to single image_url so publish/render still works pre-backfill.
  if (imageUrls.length === 0 && imageUrl) imageUrls = [imageUrl];
  return {
    id: Number(row.id),
    sku: row.sku as string,
    triggerType: row.trigger_type as string,
    language: row.language as string,
    postText: row.post_text as string,
    postTextEn: (row.post_text_en as string) || null,
    imagePath: (row.image_path as string) || null,
    imageUrl,
    imageUrls,
    oldPrice: row.old_price != null ? Number(row.old_price) : null,
    newPrice: row.new_price != null ? Number(row.new_price) : null,
    status: row.status as string,
    scheduledAt: row.scheduled_at != null ? Number(row.scheduled_at) : null,
    publishedAt: row.published_at != null ? Number(row.published_at) : null,
    facebookPostId: (row.facebook_post_id as string) || null,
    channels,
    createdAt: Number(row.created_at),
    productName: (row.name as string) || undefined,
    productImage: (row.image1 as string) || undefined,
  };
}

export async function createFacebookDraft(draft: {
  sku: string; triggerType: string; language: string; postText: string;
  postTextEn?: string | null;
  imagePath?: string | null;
  /** Public image URL (Aosom CDN). Kept for backward compat with legacy readers. Derived from imageUrls[0] if omitted. */
  imageUrl?: string | null;
  /** Ordered list of public image URLs (1–5). Used for multi-photo Facebook posts. */
  imageUrls?: string[];
  oldPrice?: number | null; newPrice?: number | null;
}): Promise<number> {
  const db = await ensureSchema();
  const urls = (draft.imageUrls ?? []).filter((u) => typeof u === "string" && u.length > 0);
  const primary = draft.imageUrl ?? urls[0] ?? null;
  const urlsJson = urls.length > 0 ? JSON.stringify(urls) : null;
  const result = await db.execute({
    sql: `INSERT INTO facebook_drafts (sku, trigger_type, language, post_text, post_text_en, image_path, image_url, image_urls, old_price, new_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [draft.sku, draft.triggerType, draft.language, draft.postText, draft.postTextEn ?? null, draft.imagePath || null, primary, urlsJson, draft.oldPrice ?? null, draft.newPrice ?? null],
  });
  return Number(result.lastInsertRowid);
}

/**
 * Merge a single channel's state into the JSON column atomically.
 * Uses SQLite's json_set so parallel publishes to different channels don't clobber each other.
 * channelKey is restricted to a-z/0-9/_ to keep the JSON path safe for SQL interpolation.
 */
export async function setDraftChannelState(id: number, channelKey: string, state: ChannelState): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(channelKey)) {
    throw new Error(`Invalid channelKey: ${channelKey}`);
  }
  const db = await ensureSchema();
  // json_set(COALESCE(channels, '{}'), '$.fb_ameublo', json(?)) mutates just the one key in-place.
  // This is a single UPDATE so it races cleanly under concurrent writes to different channels.
  await db.execute({
    sql: `UPDATE facebook_drafts SET channels = json_set(COALESCE(channels, '{}'), ?, json(?)) WHERE id = ?`,
    args: [`$.${channelKey}`, JSON.stringify(state), id],
  });
}

export async function getFacebookDrafts(filters?: { status?: string; limit?: number }): Promise<FacebookDraft[]> {
  const db = await ensureSchema();
  let sql = `SELECT fd.*, p.name, p.image1 FROM facebook_drafts fd LEFT JOIN products p ON fd.sku = p.sku`;
  const args: InValue[] = [];
  if (filters?.status) { sql += ` WHERE fd.status = ?`; args.push(filters.status); }
  sql += ` ORDER BY fd.created_at DESC`;
  if (filters?.limit) { sql += ` LIMIT ?`; args.push(filters.limit); }
  const result = await db.execute({ sql, args });
  return result.rows.map((r) => mapDraft(rowToObj(r)));
}

export async function getFacebookDraft(id: number): Promise<FacebookDraft | null> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT fd.*, p.name, p.image1 FROM facebook_drafts fd LEFT JOIN products p ON fd.sku = p.sku WHERE fd.id = ?`,
    args: [id],
  });
  return result.rows.length > 0 ? mapDraft(rowToObj(result.rows[0])) : null;
}

export async function updateFacebookDraft(id: number, fields: Record<string, unknown>): Promise<void> {
  const db = await ensureSchema();
  const allowed = new Set(["post_text", "post_text_en", "image_path", "image_url", "image_urls", "status", "scheduled_at", "published_at", "facebook_post_id", "channels"]);
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) throw new Error(`Invalid column: ${key}`);
    sets.push(`${key} = ?`);
    args.push(value as InValue);
  }
  if (sets.length === 0) return;
  args.push(id);
  await db.execute({ sql: `UPDATE facebook_drafts SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteFacebookDraft(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `DELETE FROM facebook_drafts WHERE id = ?`, args: [id] });
}

// ─── Auto-post daily counter ─────────────────────────────────────────

function todayKey(): string {
  // YYYY-MM-DD in UTC
  return new Date().toISOString().slice(0, 10);
}

export async function getAutopostCountToday(): Promise<number> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT count FROM social_autopost_counter WHERE day = ?`, args: [todayKey()] });
  if (r.rows.length === 0) return 0;
  return Number(rowToObj(r.rows[0]).count || 0);
}

export async function incrementAutopostCountToday(): Promise<number> {
  const db = await ensureSchema();
  const day = todayKey();
  await db.execute({
    sql: `INSERT INTO social_autopost_counter (day, count) VALUES (?, 1)
          ON CONFLICT(day) DO UPDATE SET count = count + 1`,
    args: [day],
  });
  const r = await db.execute({ sql: `SELECT count FROM social_autopost_counter WHERE day = ?`, args: [day] });
  return Number(rowToObj(r.rows[0]).count || 0);
}

export async function getLastPostDate(sku: string): Promise<number | null> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT MAX(published_at) as last FROM facebook_drafts WHERE sku = ? AND status = 'published'`,
    args: [sku],
  });
  if (result.rows.length === 0) return null;
  const val = rowToObj(result.rows[0]).last;
  return val != null ? Number(val) : null;
}

export async function getEligibleHighlightProduct(minDaysBetween: number): Promise<Record<string, unknown> | null> {
  const db = await ensureSchema();
  const cutoff = Math.floor(Date.now() / 1000) - minDaysBetween * 86400;
  const result = await db.execute({
    sql: `SELECT p.* FROM products p
    WHERE p.shopify_product_id IS NOT NULL AND p.qty > 0
      AND (p.last_posted_at IS NULL OR p.last_posted_at < ?)
    ORDER BY RANDOM() LIMIT 1`,
    args: [cutoff],
  });
  return result.rows.length > 0 ? rowToObj(result.rows[0]) : null;
}

export async function markProductPosted(sku: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE products SET last_posted_at = strftime('%s','now') WHERE sku = ?`, args: [sku] });
}
