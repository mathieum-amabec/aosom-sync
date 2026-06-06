// READ-ONLY dry-run for the shopify_handle backfill. No UPDATE — counts only.
// Fetches Shopify products (id + handle + variant SKUs), compares against the local
// products table, and reports how many rows the backfill would set.
import { createClient } from "@libsql/client";
import { rest, loadEnv } from "./_shopify-lib.mjs";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

// 1) Page through Shopify products (id, handle, variant SKUs).
function parseNextPageInfo(link) {
  if (!link) return null;
  const m = link.split(",").find((s) => s.includes('rel="next"'));
  if (!m) return null;
  const u = /<([^>]+)>/.exec(m);
  if (!u) return null;
  return new URL(u[1]).searchParams.get("page_info");
}

const shopById = new Map();    // shopifyId -> handle
const handleBySku = new Map(); // variant sku -> handle
let pageInfo = null, pages = 0;
do {
  const params = new URLSearchParams({ limit: "250", fields: "id,handle,variants" });
  if (pageInfo) params.set("page_info", pageInfo);
  const res = await rest(`/products.json?${params}`);
  if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status} ${await res.text()}`);
  const { products } = await res.json();
  for (const p of products) {
    const id = String(p.id);
    const handle = typeof p.handle === "string" ? p.handle : "";
    if (handle) shopById.set(id, handle);
    for (const v of p.variants || []) {
      if (v.sku) handleBySku.set(String(v.sku), handle);
    }
  }
  pageInfo = parseNextPageInfo(res.headers.get("Link"));
  pages++;
} while (pageInfo && pages < 50);

console.log(`Shopify: fetched ${shopById.size} products with a handle across ${pages} page(s); ${handleBySku.size} variant SKUs mapped.`);

// 2) Load local products. shopify_handle is added by the app's ensureSchema migration
// on deploy; it may not exist in prod yet (this raw script bypasses ensureSchema).
// Pre-migration, every row's handle is effectively empty.
const pcols = new Set(
  (await db.execute(`PRAGMA table_info(products)`)).rows.map((r) => String(r.name)),
);
const hasHandle = pcols.has("shopify_handle");
console.log(`Local products.shopify_handle column present: ${hasHandle}${hasHandle ? "" : " (will be added on deploy)"}`);
const rows = (await db.execute(
  hasHandle
    ? `SELECT sku, shopify_product_id, shopify_handle FROM products`
    : `SELECT sku, shopify_product_id, NULL AS shopify_handle FROM products`,
)).rows;
const total = rows.length;
const withId = rows.filter((r) => r.shopify_product_id != null && String(r.shopify_product_id).trim() !== "").length;
const withHandle = rows.filter((r) => r.shopify_handle != null && String(r.shopify_handle).trim() !== "").length;

// 3) Count would-update rows.
// (a) Match by shopify_product_id (the task's WHERE) — handle missing or stale.
let byIdWouldSet = 0, byIdStale = 0;
// (b) Match by SKU (fallback — useful if shopify_product_id is sparse).
let bySkuWouldSet = 0;
for (const r of rows) {
  const curHandle = r.shopify_handle != null ? String(r.shopify_handle).trim() : "";
  const pid = r.shopify_product_id != null ? String(r.shopify_product_id).trim() : "";
  if (pid && shopById.has(pid)) {
    const sh = shopById.get(pid);
    if (curHandle === "") byIdWouldSet++;
    else if (curHandle !== sh) byIdStale++;
  }
  if (curHandle === "" && handleBySku.has(String(r.sku))) bySkuWouldSet++;
}

console.log("\n=== LOCAL products ===");
console.log(`  total rows                 : ${total}`);
console.log(`  with shopify_product_id    : ${withId}`);
console.log(`  with shopify_handle already: ${withHandle}`);
console.log("\n=== DRY-RUN backfill (NO write) ===");
console.log(`  (a) match by shopify_product_id → would SET handle (currently empty): ${byIdWouldSet}`);
console.log(`      match by id but handle differs from Shopify (stale)            : ${byIdStale}`);
console.log(`  (b) match by variant SKU → would SET handle (currently empty)       : ${bySkuWouldSet}`);
console.log(`\n  Task's rule is (a) UPDATE ... WHERE shopify_product_id = ?.`);
console.log(`  If (a) is low but (b) is high, shopify_product_id is sparse on the catalog`);
console.log(`  and a SKU-based backfill would reach more rows. Awaiting validation — NOTHING written.`);
