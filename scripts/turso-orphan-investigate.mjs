// READ-ONLY investigation: for each candidate Shopify product_id (from the
// fix-primary-image ERROR/404 rows), (a) list every Turso `products` row pointing
// at it, and (b) re-verify the product live via GET /admin/api/2024-01/products/{id}.json.
// Only product_ids that return 404 are confirmed-deleted. Writes NOTHING.
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com";
const API_VERSION = "2024-01";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 8 distinct shopify_product_id from the CSV ERROR rows (fix-primary-image-report.csv).
const CANDIDATES = [
  "7736539218025", "7750489899113", "7751702610025", "7752224604265",
  "7752227815529", "7796432830569", "7798394749033", "7798394912873",
];

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

async function shopifyStatus(id) {
  const url = `https://${STORE}/admin/api/${API_VERSION}/products/${id}.json?fields=id,title,status`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN } });
  if (res.status === 429) { await sleep(2500); return shopifyStatus(id); }
  let title = "";
  if (res.ok) { try { title = (await res.json()).product?.title || ""; } catch {} }
  return { status: res.status, title };
}

// Pull every Turso row pointing at any candidate (so we catch all variant SKUs, not just the CSV subset).
const placeholders = CANDIDATES.map(() => "?").join(",");
const rows = (await db.execute({
  sql: `SELECT sku, shopify_product_id FROM products WHERE shopify_product_id IN (${placeholders}) ORDER BY shopify_product_id, sku`,
  args: CANDIDATES,
})).rows;

const byPid = new Map();
for (const r of rows) {
  const pid = String(r.shopify_product_id);
  if (!byPid.has(pid)) byPid.set(pid, []);
  byPid.get(pid).push(String(r.sku));
}

console.log(`Turso rows pointing at the ${CANDIDATES.length} candidates: ${rows.length}\n`);
const confirmed = [];
for (const pid of CANDIDATES) {
  const { status, title } = await shopifyStatus(pid);
  const skus = byPid.get(pid) || [];
  const verdict = status === 404 ? "DELETED (404)" : status === 200 ? `ALIVE (200: "${title}")` : `OTHER (${status}) — NOT deletion`;
  console.log(`${pid}  [${verdict}]  Turso SKUs (${skus.length}): ${skus.join(", ") || "(none in Turso)"}`);
  if (status === 404) confirmed.push({ pid, skus });
  await sleep(300);
}

const confirmedSkus = confirmed.flatMap((c) => c.skus);
console.log(`\n=== SUMMARY ===`);
console.log(`Confirmed-deleted (404) product_ids: ${confirmed.length} / ${CANDIDATES.length}`);
console.log(`Turso SKUs that WOULD be marked (shopify_product_id -> NULL): ${confirmedSkus.length}`);
console.log(confirmedSkus.join(", ") || "(none)");
const nonDeleted = CANDIDATES.filter((p) => !confirmed.find((c) => c.pid === p));
console.log(`\nNOT marked (alive or non-404): ${nonDeleted.join(", ") || "(none)"}`);
await db.close();
