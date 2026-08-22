#!/usr/bin/env node
/**
 * One-time backfill: enable Shopify inventory tracking on every existing variant, set its
 * available level to the safety-buffered Aosom quantity, and set each product's stock-state
 * tag (out-of-stock / back-in-stock) off the buffered availability. After this runs once,
 * the daily sync (diff-engine → applyToShopify) keeps levels and tags current.
 *
 * Stock-state tags are product-level (a product is in stock when ANY variant buffers > 0):
 *   all variants buffer to 0 → "out-of-stock" (back-in-stock removed)
 *   any variant buffers > 0  → "back-in-stock" (out-of-stock removed)
 *
 * Safety buffer (MUST match stockBufferQty in src/lib/diff-engine.ts):
 *   aosom_qty <= 10 → 0 (épuisé) ;  aosom_qty > 10 → aosom_qty - 3
 *
 * DRY-RUN by default (lists every SKU, writes nothing). Pass --apply to write.
 *   --limit N   cap the number of variants processed (for a staged rollout)
 *
 * Reads Aosom qty from the `products` table (Turso) and variants from Shopify.
 * Backs up the pre-migration variant state to data/shopify-backup/ before any write.
 * Idempotent: tracking-enable is a no-op if already tracked; set is an absolute write.
 * Throttled to ~2 req/s. Run under x64 node (see CLAUDE.md).
 *
 * Requires SHOPIFY_ACCESS_TOKEN with read_products + read_locations + write_inventory,
 * and TURSO_DATABASE_URL / TURSO_AUTH_TOKEN. NE PAS lancer --apply sans scopes confirmés
 * + checkpoint.
 *
 *   node scripts/backfill-inventory.mjs            # dry-run
 *   node scripts/backfill-inventory.mjs --apply    # write
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const THROTTLE_MS = 500; // ~2 req/s
const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

// Keep in sync with stockBufferQty() in src/lib/diff-engine.ts (sold-out threshold raised 5→10).
const safeQtyOf = (q) => (q <= 10 ? 0 : q - 3);

// Stock-state tags (mutually exclusive), driven off buffered availability.
// Keep in sync with applyStockTags() in src/lib/diff-engine.ts.
const TAG_OUT = "out-of-stock";
const TAG_BACK = "back-in-stock";
function applyStockTags(currentTags, inStock) {
  const kept = currentTags.filter((t) => {
    const lc = t.toLowerCase();
    return lc !== TAG_OUT && lc !== TAG_BACK;
  });
  kept.push(inStock ? TAG_BACK : TAG_OUT);
  return kept;
}
function tagsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}

function envVal(name) {
  if (process.env[name]) return process.env[name];
  let env = "";
  try { env = readFileSync(".env.local", "utf8"); } catch { return undefined; }
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`));
    if (m) { let v = m[1].trim(); return (v.startsWith('"') || v.startsWith("'")) ? v.slice(1, -1) : v.split(/\s+#/)[0].trim(); }
  }
  return undefined;
}

const TOKEN = envVal("SHOPIFY_ACCESS_TOKEN");
const TURSO_URL = envVal("TURSO_DATABASE_URL");
const TURSO_TOKEN = envVal("TURSO_AUTH_TOKEN");
if (!TOKEN) { console.error("missing SHOPIFY_ACCESS_TOKEN"); process.exit(1); }
if (!TURSO_URL || !TURSO_TOKEN) { console.error("missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN"); process.exit(1); }

const base = `https://${STORE}/admin/api/${API}`;
const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, init) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${base}${path}`, { headers, ...init });
    if (r.status === 429) { await sleep(parseFloat(r.headers.get("Retry-After") || "2") * 1000); continue; }
    return r;
  }
  throw new Error(`rate-limited out: ${path}`);
}

async function enableTracking(itemId) {
  const r = await req(`/inventory_items/${itemId}.json`, {
    method: "PUT",
    body: JSON.stringify({ inventory_item: { id: Number(itemId), tracked: true } }),
  });
  if (!r.ok) throw new Error(`enable tracking ${itemId}: ${r.status} — ${await r.text()}`);
}

async function setLevel(itemId, locationId, available) {
  const body = JSON.stringify({ location_id: Number(locationId), inventory_item_id: Number(itemId), available });
  let r = await req("/inventory_levels/set.json", { method: "POST", body });
  if (r.status === 422) {
    const text = await r.text();
    if (/not stocked|connect/i.test(text)) {
      const c = await req("/inventory_levels/connect.json", {
        method: "POST",
        body: JSON.stringify({ location_id: Number(locationId), inventory_item_id: Number(itemId) }),
      });
      if (!c.ok) throw new Error(`connect ${itemId}: ${c.status} — ${await c.text()}`);
      await sleep(THROTTLE_MS);
      r = await req("/inventory_levels/set.json", { method: "POST", body });
    } else {
      throw new Error(`set level ${itemId}: 422 — ${text}`);
    }
  }
  if (!r.ok) throw new Error(`set level ${itemId}: ${r.status} — ${await r.text()}`);
}

async function setProductTags(productId, tags) {
  const r = await req(`/products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: { id: Number(productId), tags: tags.join(", ") } }),
  });
  if (!r.ok) throw new Error(`set tags ${productId}: ${r.status} — ${await r.text()}`);
}

console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}${LIMIT !== Infinity ? `  limit=${LIMIT}` : ""}\n`);

// 1. Aosom qty per SKU from the products table.
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
const qtyRows = await db.execute("SELECT sku, qty FROM products");
const qtyBySku = new Map(qtyRows.rows.map((r) => [String(r.sku), Number(r.qty) || 0]));
console.log(`products table: ${qtyBySku.size} SKUs with qty\n`);

// 2. Primary location.
const locResp = await req("/locations.json");
if (!locResp.ok) throw new Error(`locations: ${locResp.status} — ${await locResp.text()} (needs read_locations scope)`);
const locations = (await locResp.json()).locations || [];
const location = locations.find((l) => l.active) ?? locations[0];
if (!location) throw new Error("no Shopify locations");
const locationId = String(location.id);
console.log(`location: ${locationId} "${location.name}"\n`);

// 3. All Shopify products + variants (sku → inventory_item_id; product → tags).
const variants = [];
const products = []; // { id, tags:[], skus:[] } — tags are product-level
let pageInfo = null;
do {
  const params = new URLSearchParams({ limit: "250", fields: "id,variants,tags" });
  if (pageInfo) params.set("page_info", pageInfo);
  const r = await req(`/products.json?${params}`);
  if (!r.ok) throw new Error(`products: ${r.status} — ${await r.text()}`);
  const data = await r.json();
  for (const p of data.products) {
    const skus = [];
    for (const v of (p.variants || [])) {
      if (v.sku && v.inventory_item_id) {
        variants.push({ sku: v.sku, itemId: String(v.inventory_item_id), inventory_management: v.inventory_management, current: v.inventory_quantity });
        skus.push(v.sku);
      }
    }
    const tags = typeof p.tags === "string" ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    products.push({ id: String(p.id), tags, skus });
  }
  const link = r.headers.get("Link"); const m = link && link.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  pageInfo = m ? m[1] : null;
} while (pageInfo);
console.log(`shopify products: ${products.length}, variants: ${variants.length}\n`);

// 4. Backup pre-migration state (variants + product tags).
mkdirSync("data/shopify-backup", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = `data/shopify-backup/inventory-backfill-${stamp}.json`;
writeFileSync(backupPath, JSON.stringify({ locationId, variants, products }, null, 2));
console.log(`backup written: ${backupPath}\n`);

// 5. Process.
let changed = 0, skippedNoQty = 0, failed = 0, processed = 0;
for (const v of variants) {
  if (processed >= LIMIT) break;
  if (!qtyBySku.has(v.sku)) { skippedNoQty++; continue; }
  processed++;
  const aosomQty = qtyBySku.get(v.sku);
  const safeQty = safeQtyOf(aosomQty);
  console.log(`SKU ${v.sku} : aosom=${aosomQty} → shopify=${safeQty}`);
  if (!APPLY) { changed++; continue; }
  try {
    await enableTracking(v.itemId);
    await sleep(THROTTLE_MS);
    await setLevel(v.itemId, locationId, safeQty);
    await sleep(THROTTLE_MS);
    changed++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${v.sku}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 6. Product stock-state tags (out-of-stock / back-in-stock), driven off buffered
// availability: a product is in stock when ANY of its variants buffers > 0. --limit
// caps the inventory pass above, not tags. Only writes when the tag set changes.
console.log(`\n--- tags ---`);
let tagChanged = 0, tagSkipped = 0, tagFailed = 0;
for (const p of products) {
  const known = p.skus.filter((s) => qtyBySku.has(s));
  if (known.length === 0) { tagSkipped++; continue; } // no products-table qty → leave tags alone
  const inStock = known.some((s) => safeQtyOf(qtyBySku.get(s)) > 0);
  const desired = applyStockTags(p.tags, inStock);
  if (tagsEqual(desired, p.tags)) { tagSkipped++; continue; }
  console.log(`product ${p.id} : ${inStock ? "back-in-stock" : "out-of-stock"}  (was: [${p.tags.join(", ")}])`);
  if (!APPLY) { tagChanged++; continue; }
  try {
    await setProductTags(p.id, desired);
    await sleep(THROTTLE_MS);
    tagChanged++;
  } catch (err) {
    tagFailed++;
    console.error(`  ✗ product ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`inventory: processed=${processed}  ${APPLY ? "written" : "would write"}=${changed}  skipped(no qty)=${skippedNoQty}  failed=${failed}`);
console.log(`tags:      ${APPLY ? "written" : "would write"}=${tagChanged}  unchanged/skipped=${tagSkipped}  failed=${tagFailed}`);
console.log(APPLY ? "Applied." : "Dry-run only. Re-run with --apply to write.");
