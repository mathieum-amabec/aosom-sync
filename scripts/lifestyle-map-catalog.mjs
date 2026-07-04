// PHASE 1 STEP 1-2 — Map the full Shopify catalog and cross-reference against the
// existing v1 classification (first759) + the executed swap plans to bucket every
// product. READ-ONLY on Shopify (GET only). Writes local JSON only.
//
// Output:
//   catalog-all-products.json          — every Shopify product {id,handle,title}
//   lifestyle-catalog-map.json         — full bucketed map + the never-scanned todo list
import { readFileSync, writeFileSync } from "node:fs";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: no SHOPIFY_ACCESS_TOKEN in .env.local"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastShop = 0;
async function shopGet(url) {
  for (let a = 0; a < 6; a++) {
    const w = 500 - (Date.now() - lastShop); if (w > 0) await sleep(w); lastShop = Date.now();
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" } });
    if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; }
    if (res.status === 401 || res.status === 403) { console.error(`FATAL: Shopify ${res.status} (token invalid/insufficient scope). Stopping.`); process.exit(2); }
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }
  throw new Error("Shopify GET failed after retries (429)");
}
function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) { const m = part.match(/<([^>]+)>;\s*rel="next"/); if (m) return m[1]; }
  return null;
}

// STEP 1 — paginate all products
const all = [];
let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,handle,title`;
let page = 0;
while (url) {
  const res = await shopGet(url);
  const body = await res.json();
  for (const p of body.products || []) all.push({ id: p.id, handle: p.handle, title: p.title });
  page++;
  process.stderr.write(`  page ${page}: +${(body.products || []).length} (total ${all.length})\n`);
  url = nextLink(res.headers.get("link") || res.headers.get("Link"));
}
writeFileSync(new URL("../catalog-all-products.json", import.meta.url), JSON.stringify(all, null, 0));
console.log(`\nTotal Shopify products: ${all.length}`);

// STEP 2 — cross-reference
const v1 = JSON.parse(readFileSync(new URL("../lifestyle-classification-first759.detail.json", import.meta.url), "utf8"));
const v1ById = new Map(v1.map((p) => [String(p.id), p]));
const clean21 = JSON.parse(readFileSync(new URL("../pos1-swap-plan-clean21.json", import.meta.url), "utf8"));
const clean324 = JSON.parse(readFileSync(new URL("../pos1-swap-plan-clean324.json", import.meta.url), "utf8"));
const executedSwap = new Set([...clean21, ...clean324].map((p) => String(p.id))); // 345 confirmed clean-pos1

// v2 recheck CSV -> action per id
function parseCSV(t){const rows=[];let i=0,f="",row=[],q=false;while(i<t.length){const c=t[i];if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i+=2;continue;}q=false;i++;continue;}f+=c;i++;continue;}if(c==='"'){q=true;i++;continue;}if(c===","){row.push(f);f="";i++;continue;}if(c==="\n"||c==="\r"){if(c==="\r"&&t[i+1]==="\n")i++;row.push(f);rows.push(row);row=[];f="";i++;continue;}f+=c;i++;}if(f.length||row.length){row.push(f);rows.push(row);}return rows;}
const v2rows = parseCSV(readFileSync(new URL("../lifestyle-classification-v2-no_lifestyle_recheck.csv", import.meta.url), "utf8"));
const vh = v2rows[0]; const vai = vh.indexOf("action"), vidi = vh.indexOf("shopify_product_id");
const v2action = new Map();
for (let k = 1; k < v2rows.length; k++) { if (v2rows[k].length <= vai) continue; v2action.set(String(v2rows[k][vidi]), v2rows[k][vai]); }

const buckets = { executed_clean: [], swap_text: [], still_no_lifestyle: [], v1_swap_unexecuted: [], v1_ok: [], never_scanned: [] };
for (const p of all) {
  const id = String(p.id);
  if (executedSwap.has(id)) { buckets.executed_clean.push(id); continue; }
  const v2a = v2action.get(id);
  if (v2a === "SWAP_TEXT") { buckets.swap_text.push(id); continue; }
  if (v2a === "STILL_NO_LIFESTYLE") { buckets.still_no_lifestyle.push(id); continue; }
  const v1p = v1ById.get(id);
  if (v1p) {
    if (v1p.action === "OK") { buckets.v1_ok.push(id); continue; }
    if (v1p.action === "SWAP") { buckets.v1_swap_unexecuted.push(id); continue; }
    // v1 NO_LIFESTYLE but not in v2 map (shouldn't happen) -> treat as still_no_lifestyle
    buckets.still_no_lifestyle.push(id); continue;
  }
  buckets.never_scanned.push(id);
}

const byId = new Map(all.map((p) => [String(p.id), p]));
const neverScanned = buckets.never_scanned.map((id) => byId.get(id));
writeFileSync(new URL("../lifestyle-catalog-map.json", import.meta.url), JSON.stringify({ total: all.length, buckets, neverScanned }, null, 0));

console.log("\n=== BUCKET COUNTS ===");
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(22)} ${v.length}`);
const acct = Object.values(buckets).reduce((s, v) => s + v.length, 0);
console.log(`  ${"SUM".padEnd(22)} ${acct}  (should equal ${all.length})`);
console.log(`\nNever-scanned to classify: ${buckets.never_scanned.length}`);
