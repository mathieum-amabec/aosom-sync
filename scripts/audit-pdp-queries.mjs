// Read-only audit queries for the PDP/video audit (CHANTIER 1).
// - Top-N by inferred stock velocity (price_history stock_change decreases).
// - Video-field population + sample URLs (Aosom CSV `Video` -> products.video).
// No writes. Connects to Turso via TURSO_* from .env.local.
import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";

const env = loadEnv();
const url = env.TURSO_DATABASE_URL;
const authToken = env.TURSO_AUTH_TOKEN;
if (!url) throw new Error("TURSO_DATABASE_URL missing in .env.local");
const db = createClient({ url, authToken });

const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;

// --- Totals ---
const [{ c: total }] = await q("SELECT COUNT(*) AS c FROM products");
const [{ c: imported }] = await q("SELECT COUNT(*) AS c FROM products WHERE shopify_product_id IS NOT NULL");
console.log(`TOTAL_PRODUCTS=${total}  IMPORTED_TO_SHOPIFY=${imported}`);

// --- Video field population ---
const [{ c: withVideo }] = await q("SELECT COUNT(*) AS c FROM products WHERE video IS NOT NULL AND TRIM(video) != ''");
console.log(`PRODUCTS_WITH_VIDEO=${withVideo}`);
const vids = await q("SELECT sku, name, video FROM products WHERE video IS NOT NULL AND TRIM(video) != '' LIMIT 5");
console.log("--- VIDEO SAMPLES ---");
for (const r of vids) console.log(`${r.sku} | ${String(r.name).slice(0,40)} | ${r.video}`);

// --- price_history availability ---
const [{ c: phRows }] = await q("SELECT COUNT(*) AS c FROM price_history");
const [{ c: phStock }] = await q("SELECT COUNT(*) AS c FROM price_history WHERE change_type='stock_change'");
console.log(`PRICE_HISTORY_ROWS=${phRows}  STOCK_CHANGE_ROWS=${phStock}`);

// --- Top 30 by inferred stock velocity, 30-day window ---
console.log("--- TOP 30 BY INFERRED STOCK VELOCITY (30d) ---");
const top = await q(
  `SELECT ph.sku, p.name, p.price, p.shopify_handle,
          SUM(ph.old_qty - ph.new_qty) AS units_moved,
          COUNT(DISTINCT date(ph.detected_at,'unixepoch')) AS active_days
   FROM price_history ph JOIN products p ON ph.sku = p.sku
   WHERE ph.change_type='stock_change'
     AND ph.detected_at > cast(strftime('%s','now','-30 days') as integer)
     AND ph.old_qty > ph.new_qty
   GROUP BY ph.sku ORDER BY units_moved DESC LIMIT 30`
);
if (top.length === 0) {
  console.log("(no stock_change decreases in last 30d — velocity ranking unavailable)");
} else {
  top.forEach((r, i) => console.log(`${String(i+1).padStart(2)}. ${r.sku} | moved=${r.units_moved} | days=${r.active_days} | $${r.price} | ${String(r.name).slice(0,45)}`));
}

await db.close();
