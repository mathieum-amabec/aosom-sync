// READ-ONLY diagnostic: find duplicate Shopify products (sharing variant SKUs) and
// propose which to keep vs delete. NO deletion — dry-run only. Rate-limited ~2 req/sec.
//
// Selection rule (keep ONE per duplicate cluster):
//   P1: status === 'active' (published) beats draft/archived
//   P2: most recent updated_at
//   P3: the product whose handle is the one currently referenced in our DB (products.shopify_handle)
import { createClient } from "@libsql/client";
import { rest, loadEnv, sleep } from "./_shopify-lib.mjs";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

// --- DB: which handles does our catalog currently point at (for P3 tie-break) ---
let dbHandles = new Set();
try {
  const rows = (await db.execute(`SELECT DISTINCT shopify_handle FROM products WHERE shopify_handle IS NOT NULL AND shopify_handle != ''`)).rows;
  dbHandles = new Set(rows.map((r) => String(r.shopify_handle)));
} catch (e) { console.warn("  (couldn't read DB handles for P3 tie-break:", e.message, ")"); }

// --- Shopify: page through all products ---
function nextPageInfo(link) {
  if (!link) return null;
  const part = link.split(",").find((s) => s.includes('rel="next"'));
  const u = part && /<([^>]+)>/.exec(part);
  return u ? new URL(u[1]).searchParams.get("page_info") : null;
}
const products = new Map(); // id -> { id, title, handle, status, created_at, updated_at, skus[] }
let pageInfo = null, pages = 0;
do {
  const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,status,variants,created_at,updated_at" });
  if (pageInfo) params.set("page_info", pageInfo);
  const res = await rest(`/products.json?${params}`);
  if (!res.ok) throw new Error(`Shopify fetch failed: ${res.status} ${await res.text()}`);
  const { products: page } = await res.json();
  for (const p of page) {
    products.set(String(p.id), {
      id: String(p.id),
      title: p.title || "",
      handle: p.handle || "",
      status: p.status || "",
      created_at: p.created_at || "",
      updated_at: p.updated_at || "",
      skus: (p.variants || []).map((v) => v.sku).filter((s) => s && String(s).trim() !== "").map(String),
    });
  }
  pageInfo = nextPageInfo(res.headers.get("Link"));
  pages++;
  if (pageInfo) await sleep(500);
} while (pageInfo && pages < 50);
console.log(`Fetched ${products.size} Shopify products over ${pages} page(s).`);

// --- ÉTAPE 1: SKU -> product ids; find SKUs on >1 product ---
const skuToProducts = new Map();
for (const p of products.values()) {
  for (const sku of p.skus) {
    if (!skuToProducts.has(sku)) skuToProducts.set(sku, new Set());
    skuToProducts.get(sku).add(p.id);
  }
}
const dupSkus = [...skuToProducts.entries()].filter(([, ids]) => ids.size > 1);

// --- Cluster products connected by any shared SKU (union-find) ---
const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
for (const p of products.values()) parent.set(p.id, p.id);
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
for (const [, ids] of dupSkus) {
  const arr = [...ids];
  for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
}
const clusters = new Map(); // root -> Set(productId)
for (const [, ids] of dupSkus) {
  for (const id of ids) {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root).add(id);
  }
}

// --- ÉTAPE 2: pick keeper per cluster ---
function rank(p) {
  // higher is better
  return [
    p.status === "active" ? 1 : 0,                  // P1 published
    Date.parse(p.updated_at) || 0,                  // P2 most recent
    dbHandles.has(p.handle) ? 1 : 0,                // P3 DB-referenced handle
  ];
}
function better(a, b) {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) { if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b; }
  return a.id <= b.id ? a : b; // deterministic final tie-break
}

const toDelete = new Map(); // id -> {product, keptId}
const clusterReports = [];
for (const ids of clusters.values()) {
  const members = [...ids].map((id) => products.get(id));
  let keeper = members[0];
  for (const m of members.slice(1)) keeper = better(keeper, m);
  const deletes = members.filter((m) => m.id !== keeper.id);
  for (const d of deletes) toDelete.set(d.id, { product: d, keptId: keeper.id });
  clusterReports.push({ keeper, members, sharedSkus: members[0].skus.filter((s) => skuToProducts.get(s)?.size > 1) });
}

// --- Output ---
const fmt = (p) => `id=${p.id} status=${p.status} updated=${p.updated_at} dbHandle=${dbHandles.has(p.handle) ? "Y" : "n"} "${p.title.slice(0, 60)}"`;
console.log(`\n========== ÉTAPE 1 — DUPLICATE SKUs ==========`);
console.log(`Duplicate SKUs (on >1 product): ${dupSkus.length}`);
console.log(`Duplicate product clusters     : ${clusters.size}`);
console.log(`Products involved in clusters  : ${[...clusters.values()].reduce((n, s) => n + s.size, 0)}`);

console.log(`\n========== ÉTAPE 2 — KEEP / DELETE per cluster ==========`);
let ci = 0;
for (const rep of clusterReports.sort((a, b) => b.members.length - a.members.length)) {
  ci++;
  const skus = [...new Set(rep.members.flatMap((m) => m.skus))].filter((s) => skuToProducts.get(s)?.size > 1);
  console.log(`\nCluster #${ci} (${rep.members.length} products; shared SKUs: ${skus.slice(0, 6).join(", ")}${skus.length > 6 ? "…" : ""})`);
  console.log(`  KEEP   → ${fmt(rep.keeper)}`);
  for (const m of rep.members) if (m.id !== rep.keeper.id) console.log(`  DELETE → ${fmt(m)}`);
}

console.log(`\n========== ÉTAPE 3 — DRY-RUN: products that WOULD be deleted ==========`);
console.log(`Total products to delete: ${toDelete.size} (NOTHING deleted)`);
const byStatus = {};
let dbReferencedDeletes = 0;
for (const { product } of toDelete.values()) {
  byStatus[product.status] = (byStatus[product.status] || 0) + 1;
  if (dbHandles.has(product.handle)) dbReferencedDeletes++;
}
console.log(`By status: ${JSON.stringify(byStatus)}`);
console.log(`⚠ to-delete products our DB currently links to (dbHandle=Y): ${dbReferencedDeletes}`);
console.log(`  → after deletion, re-run the SKU handle backfill so links point at the kept products.`);
for (const { product, keptId } of [...toDelete.values()].sort((a, b) => a.product.status.localeCompare(b.product.status))) {
  console.log(`  DELETE id=${product.id} [${product.status}] "${product.title.slice(0, 70)}" (keep ${keptId})`);
}
console.log(`\nSUMMARY_JSON ${JSON.stringify({ totalProducts: products.size, dupSkus: dupSkus.length, clusters: clusters.size, toDelete: toDelete.size, byStatus })}`);
console.log(`\n(NO deletion performed — read-only diagnostic. Awaiting Mat's validation.)`);
