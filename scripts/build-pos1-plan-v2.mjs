// STEP 2-3: build the pos-1 swap plan for the 324 v2 SWAP_CLEAN products.
// READ-ONLY on Shopify (GET images only). Resolves the hero image_id for each product's
// best_lifestyle_position, builds pos1-swap-plan-clean324.json. Resumable via a checkpoint.
//   node scripts/build-pos1-plan-v2.mjs <csvPath>
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) throw new Error("Missing SHOPIFY_ACCESS_TOKEN");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function shopGet(path) {
  for (let a = 0; a < 6; a++) {
    const w = 500 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); // 2 req/sec
    const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, { headers: H });
    if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; }
    return res;
  }
  throw new Error("429 after retries");
}
const stem = (u) => (u || "").split("?")[0].split("/").pop();

function parseCsvLine(l) { const o = []; let c = "", q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { o.push(c); c = ""; } else c += ch; } o.push(c); return o; }

const csvPath = process.argv[2];
if (!csvPath) throw new Error("usage: node build-pos1-plan-v2.mjs <csvPath>");
const lines = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
const head = lines[0].split(",");
const col = (n) => head.indexOf(n);
const rows = lines.slice(1).map(parseCsvLine).map((r) => ({
  id: r[col("shopify_product_id")], handle: r[col("handle")], title: r[col("title")],
  total_images: r[col("total_images")], best_position: r[col("best_lifestyle_position")],
  best_url: r[col("best_lifestyle_url")], action: r[col("action")],
})).filter((r) => r.action === "SWAP_CLEAN");
process.stderr.write(`SWAP_CLEAN rows: ${rows.length}\n`);

// resume
const ckpt = new URL("../pos1-plan-v2.checkpoint.jsonl", import.meta.url);
const done = new Map();
if (existsSync(ckpt)) { for (const l of readFileSync(ckpt, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); done.set(String(o.id), o); } catch {} } process.stderr.write(`resume: ${done.size} already resolved\n`); }

let i = 0;
for (const r of rows) {
  i++;
  if (done.has(String(r.id))) continue;
  let rec;
  try {
    const res = await shopGet(`/products/${r.id}/images.json`);
    if (res.status === 404) throw new Error("product 404");
    if (!res.ok) throw new Error(`images ${res.status}`);
    const imgs = ((await res.json()).images || []).slice().sort((a, b) => a.position - b.position);
    if (!imgs.length) throw new Error("no images");
    const hero = imgs.find((im) => im.src === r.best_url)
      || imgs.find((im) => stem(im.src) === stem(r.best_url))
      || imgs.find((im) => im.position === Number(r.best_position));
    if (!hero) throw new Error(`hero not matched (best_url stem ${stem(r.best_url)}, pos ${r.best_position})`);
    rec = { id: Number(r.id), ok: true, entry: {
      id: Number(r.id), handle: r.handle, title: r.title, image_count: imgs.length,
      best_position: Number(r.best_position), best_url: r.best_url,
      hero_image_id: hero.id, hero_current_position: hero.position, hero_file: stem(hero.src),
      apply: { method: "PUT", endpoint: `/products/${r.id}/images/${hero.id}.json`, body: { image: { id: hero.id, position: 1 } } },
    } };
    process.stderr.write(`  [${i}/${rows.length}] ${r.id} hero ${hero.id} pos ${hero.position}->1 (of ${imgs.length})\n`);
  } catch (e) {
    rec = { id: Number(r.id), ok: false, handle: r.handle, error: String(e.message).slice(0, 160) };
    process.stderr.write(`  [${i}/${rows.length}] ${r.id} ERROR ${e.message}\n`);
  }
  done.set(String(r.id), rec);
  appendFileSync(ckpt, JSON.stringify(rec) + "\n");
}

// assemble plan + validation (only when all rows processed)
if (done.size >= rows.length) {
  const recs = rows.map((r) => done.get(String(r.id)));
  const ok = recs.filter((x) => x && x.ok).map((x) => x.entry);
  const failed = recs.filter((x) => x && !x.ok);
  const ids = ok.map((e) => e.id);
  const dupes = ids.filter((v, idx) => ids.indexOf(v) !== idx);
  writeFileSync(new URL("../pos1-swap-plan-clean324.json", import.meta.url), JSON.stringify(ok, null, 2));
  process.stderr.write(`\nPLAN DONE: resolved ${ok.length}, failed ${failed.length}, dupes ${dupes.length}\n`);
  if (failed.length) for (const f of failed) process.stderr.write(`  FAIL ${f.id} ${f.handle}: ${f.error}\n`);
  console.log(JSON.stringify({ resolved: ok.length, failed: failed.length, dupes: dupes.length, failures: failed }, null, 2));
} else {
  process.stderr.write(`\nINCOMPLETE: ${done.size}/${rows.length} — rerun to resume\n`);
}
