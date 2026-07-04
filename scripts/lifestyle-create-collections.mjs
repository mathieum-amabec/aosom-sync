// PHASE 3 STEP 3-4 — create the two filtered smart collections. Idempotent (skips if the
// handle already exists). Needs --apply to write. Reports product count in each.
//   node scripts/lifestyle-create-collections.mjs [--apply]
//
// nouveaux-arrivages-lifestyle : tag == lifestyle-verified, sort created-desc (mirrors
//                                the current "nouveaux-arrivages" ordering, filtered).
// rabais-lifestyle             : tag == lifestyle-verified AND variant_compare_at_price > 0.
//   NOTE: the live "rabais" collection is DISJUNCTIVE (compare_at>0 OR tag sale OR tag
//   rabais). Shopify smart collections cannot AND a tag with an OR-group, so we use the
//   compare_at>0 discount signal (the dominant rule). Tag-only sale products without a
//   compare_at price are not captured — flagged in the report.
import { readFileSync } from "node:fs";
function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: no token"); process.exit(2); }
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function shop(method, path, body) { for (let a = 0; a < 6; a++) { const w = 500 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; } if (res.status === 401 || res.status === 403) { console.error(`FATAL: Shopify ${res.status}`); process.exit(2); } return res; } throw new Error("429 after retries"); }

const DEFS = [
  { handle: "nouveaux-arrivages-lifestyle", title: "Nouveaux arrivages (lifestyle)", disjunctive: false, sort_order: "created-desc", rules: [{ column: "tag", relation: "equals", condition: "lifestyle-verified" }] },
  { handle: "rabais-lifestyle", title: "Rabais (lifestyle)", disjunctive: false, sort_order: "best-selling", rules: [{ column: "tag", relation: "equals", condition: "lifestyle-verified" }, { column: "variant_compare_at_price", relation: "greater_than", condition: "0" }] },
];

async function findByHandle(handle) { const r = await shop("GET", `/smart_collections.json?handle=${handle}`); const j = await r.json(); return (j.smart_collections || [])[0] || null; }
async function countIn(id) { const r = await shop("GET", `/products/count.json?collection_id=${id}`); return (await r.json()).count; }

const out = [];
for (const d of DEFS) {
  let col = await findByHandle(d.handle);
  if (col) { process.stderr.write(`  exists: ${d.handle} (id ${col.id})\n`); }
  else if (!APPLY) { process.stderr.write(`  DRY-RUN would create: ${d.handle}\n`); out.push({ handle: d.handle, created: false, dryRun: true }); continue; }
  else {
    const r = await shop("POST", `/smart_collections.json`, { smart_collection: { title: d.title, handle: d.handle, disjunctive: d.disjunctive, sort_order: d.sort_order, rules: d.rules, published: true } });
    if (r.status !== 201) { const err = (await r.text()).slice(0, 300); process.stderr.write(`  CREATE FAIL ${d.handle}: ${r.status} ${err}\n`); out.push({ handle: d.handle, created: false, error: err }); continue; }
    col = (await r.json()).smart_collection; process.stderr.write(`  created: ${d.handle} (id ${col.id})\n`);
  }
  const count = col ? await countIn(col.id) : null;
  out.push({ handle: d.handle, id: col ? col.id : null, count, rules: d.rules, disjunctive: d.disjunctive, sort_order: d.sort_order });
}
console.log(JSON.stringify(out, null, 2));
