// READ-ONLY diagnostic for the "Product page unavailable" GMC issue (267 products).
// NO writes anywhere. Tests the hypothesis "feed uses auto-generated URLs instead of
// Turso shopify_handle" by:
//   1. Reproducing the exact feed items source.ts would emit (Shopify live handle + same filters).
//   2. Loading Turso products.shopify_handle (by shopify_product_id and by SKU).
//   3. Comparing Shopify-live handle vs Turso handle for every feed product.
//   4. HTTP-checking a sample of the ACTUAL feed URLs on the live storefront to see the
//      real HTTP status (200 / 3xx / 404) — the ground truth for "page unavailable".
// Rate limits respected: Shopify Admin ≤2 req/s (550ms spacing); storefront checks paced 400ms.
import { createClient } from "@libsql/client";
import { rest, loadEnv, sleep } from "./_shopify-lib.mjs";

const STOREFRONT = "https://ameublodirect.ca";
const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

function parseNextPageInfo(link) {
  if (!link) return null;
  const m = link.split(",").find((s) => s.includes('rel="next"'));
  const u = m && /<([^>]+)>/.exec(m);
  return u ? new URL(u[1]).searchParams.get("page_info") : null;
}

// ── 1) Reproduce the feed items (mirror source.ts filters) ──────────────────
const feedProducts = []; // {pid, handle, title, sku, published_at}
let pageInfo = null, pages = 0, activeCount = 0, unpublished = 0, noImage = 0;
do {
  const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,status,published_at,images,variants" });
  if (pageInfo) params.set("page_info", pageInfo);
  const res = await rest(`/products.json?${params}`);
  if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status} ${await res.text()}`);
  const { products } = await res.json();
  for (const p of products) {
    if (p.status !== "active") continue;
    activeCount++;
    if (!p.published_at || new Date(p.published_at).getTime() > Date.now()) { unpublished++; continue; }
    if (!p.handle) continue;
    const imgs = (p.images ?? []).map((i) => i.src).filter(Boolean);
    if (imgs.length === 0) { noImage++; continue; }
    const firstSku = (p.variants ?? []).find((v) => v.sku && String(v.sku).trim() !== "" && (parseFloat(v.price ?? "0") || 0) > 0);
    if (!firstSku) continue;
    feedProducts.push({ pid: String(p.id), handle: p.handle, title: p.title, sku: String(firstSku.sku), published_at: p.published_at });
  }
  pageInfo = parseNextPageInfo(res.headers.get("Link"));
  pages++;
  await sleep(550); // ≤2 req/s
} while (pageInfo && pages < 80);

console.log(`\n[Shopify] pages=${pages}  active=${activeCount}  excluded(unpublished)=${unpublished}  excluded(no image)=${noImage}  → feed products=${feedProducts.length}`);

// ── 2) Load Turso handles ───────────────────────────────────────────────────
const pcols = new Set((await db.execute(`PRAGMA table_info(products)`)).rows.map((r) => String(r.name)));
if (!pcols.has("shopify_handle")) { console.log("Turso products.shopify_handle column MISSING"); }
const trows = (await db.execute(`SELECT sku, shopify_product_id, shopify_handle FROM products`)).rows;
const tursoByPid = new Map(), tursoBySku = new Map();
let tursoWithHandle = 0;
for (const r of trows) {
  const h = r.shopify_handle != null ? String(r.shopify_handle).trim() : "";
  if (h) tursoWithHandle++;
  const pid = r.shopify_product_id != null ? String(r.shopify_product_id).trim() : "";
  if (pid) tursoByPid.set(pid, h);
  if (r.sku != null) tursoBySku.set(String(r.sku), h);
}
console.log(`[Turso] products rows=${trows.length}  with non-empty shopify_handle=${tursoWithHandle}`);

// ── 3) Compare Shopify-live vs Turso handle per feed product ─────────────────
let same = 0, differ = 0, tursoMissing = 0;
const mismatches = [];
for (const fp of feedProducts) {
  const turso = tursoByPid.get(fp.pid) ?? tursoBySku.get(fp.sku) ?? "";
  if (!turso) { tursoMissing++; continue; }
  if (turso === fp.handle) same++;
  else { differ++; mismatches.push({ ...fp, turso }); }
}
console.log(`\n=== HANDLE SOURCE COMPARISON (Shopify-live vs Turso) ===`);
console.log(`  identical handle          : ${same}`);
console.log(`  DIFFERENT handle          : ${differ}   <-- switching source would change these`);
console.log(`  Turso handle missing/empty: ${tursoMissing}   <-- switching source would BREAK these (null handle)`);

console.log(`\n=== 5 BEFORE/AFTER URL EXAMPLES ===`);
const examples = (mismatches.length ? mismatches : feedProducts.slice(0, 5).map((f) => ({ ...f, turso: tursoByPid.get(f.pid) ?? tursoBySku.get(f.sku) ?? "(none)" }))).slice(0, 5);
for (const e of examples) {
  console.log(`  • ${e.title.slice(0, 48)}`);
  console.log(`      BEFORE (Shopify): ${STOREFRONT}/products/${e.handle}`);
  console.log(`      AFTER  (Turso)  : ${STOREFRONT}/products/${e.turso}`);
}

// ── 4) HTTP-check a sample of the ACTUAL feed URLs (ground truth) ────────────
async function check(url) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; feed-diagnostic/1.0)" } });
    return { status: res.status, location: res.headers.get("location") || "" };
  } catch (e) { return { status: 0, location: `ERR ${e.message}` }; }
}
// Sample: up to 40 feed products, prioritising mismatches, then a spread of the rest.
const sample = [];
const seen = new Set();
for (const m of mismatches.slice(0, 15)) { sample.push(m); seen.add(m.pid); }
for (let i = 0; i < feedProducts.length && sample.length < 40; i += Math.max(1, Math.floor(feedProducts.length / 40))) {
  const fp = feedProducts[i]; if (!seen.has(fp.pid)) { sample.push({ ...fp, turso: tursoByPid.get(fp.pid) ?? tursoBySku.get(fp.sku) ?? "" }); seen.add(fp.pid); }
}
console.log(`\n=== LIVE STOREFRONT HTTP CHECK (sample of ${sample.length} current feed URLs) ===`);
const tally = {};
const bad = [];
for (const s of sample) {
  const url = `${STOREFRONT}/products/${s.handle}`;
  const r = await check(url);
  tally[r.status] = (tally[r.status] || 0) + 1;
  if (r.status !== 200) {
    let alt = null;
    if (s.turso && s.turso !== s.handle) { await sleep(400); alt = await check(`${STOREFRONT}/products/${s.turso}`); }
    bad.push({ title: s.title.slice(0, 40), handle: s.handle, status: r.status, location: r.location.slice(0, 60), turso: s.turso, altStatus: alt?.status });
  }
  await sleep(400);
}
console.log(`  status tally: ${JSON.stringify(tally)}`);
if (bad.length) {
  console.log(`  NON-200 current feed URLs (${bad.length}):`);
  for (const b of bad) console.log(`   [${b.status}] ${b.handle}  ${b.location ? "→ " + b.location : ""}  ${b.turso && b.turso !== b.handle ? `| turso-handle '${b.turso}' → HTTP ${b.altStatus}` : "| turso handle same/none"}`);
} else {
  console.log(`  all sampled current feed URLs returned 200 ✓`);
}
console.log(`\nDONE (read-only — nothing written).`);
