// DRY-RUN planner: for each CLEAN-hero SWAP (action=SWAP & best_lifestyle_has_text_overlay=false),
// fetch the product's current image order (GET only) and compute the pos-1 reorder plan.
// NO writes. Emits a human-readable before/after and a JSON plan file for a later apply step.
//   node scripts/plan-pos1-swaps.mjs
import { readFileSync, writeFileSync } from "node:fs";

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
const API = "2024-01";
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// naive-but-correct CSV line parse (handles quoted fields)
function parseCsvLine(l) {
  const out = []; let cur = "", q = false;
  for (const ch of l) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const H = ["id", "handle", "title", "pos1cls", "pos1txt", "bestpos", "besturl", "besttxt", "conf", "action"];
const csv = readFileSync(new URL("../lifestyle-classification-first759.csv", import.meta.url), "utf8").trim().split(/\r?\n/).slice(1);
const rows = csv.map((l) => Object.fromEntries(parseCsvLine(l).map((v, i) => [H[i], v])));
const clean = rows.filter((r) => r.action === "SWAP" && r.besttxt === "false");
process.stderr.write(`CLEAN-hero SWAP products: ${clean.length}\n`);

const stripQ = (u) => (u || "").split("?")[0];
const stem = (u) => stripQ(u).split("/").pop();

let lastGet = 0;
async function shopGet(url) {
  const w = 500 - (Date.now() - lastGet); if (w > 0) await sleep(w); lastGet = Date.now();
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`GET ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

const plan = [];
for (const r of clean) {
  const body = await shopGet(`https://${STORE}/admin/api/${API}/products/${r.id}.json?fields=id,title,handle,images`);
  const imgs = (body.product.images || []).slice().sort((a, b) => a.position - b.position);
  // find the hero image (matches best_lifestyle_url) by exact src, then path, then filename stem
  let hero = imgs.find((im) => im.src === r.besturl)
    || imgs.find((im) => stripQ(im.src) === stripQ(r.besturl))
    || imgs.find((im) => stem(im.src) === stem(r.besturl));
  const pos1img = imgs.find((im) => im.position === 1);
  if (!hero) {
    plan.push({ id: r.id, handle: r.handle, error: "hero image not matched in product", besturl: r.besturl });
    process.stderr.write(`  ${r.id} ${r.handle} -> ERROR hero not matched\n`);
    continue;
  }
  // proposed order: hero first, then all others keeping their relative order
  const after = [hero, ...imgs.filter((im) => im.id !== hero.id)];
  plan.push({
    id: body.product.id,
    handle: body.product.handle,
    title: body.product.title,
    image_count: imgs.length,
    confidence: Number(r.conf),
    hero_image_id: hero.id,
    hero_current_position: hero.position,
    before: imgs.map((im) => ({ position: im.position, image_id: im.id, filename: stem(im.src) })),
    after: after.map((im, i) => ({ position: i + 1, image_id: im.id, filename: stem(im.src) })),
    // the minimal write to achieve it: move hero image to position 1
    apply: { method: "PUT", endpoint: `/products/${body.product.id}/images/${hero.id}.json`, body: { image: { id: hero.id, position: 1 } } },
  });
  process.stderr.write(`  ${r.id} ${r.handle} -> hero img ${hero.id} pos ${hero.position}->1 (of ${imgs.length})\n`);
}

const outPlan = new URL("../pos1-swap-plan-clean21.json", import.meta.url);
writeFileSync(outPlan, JSON.stringify(plan, null, 2));

// human-readable
console.log(`\nDRY-RUN — pos-1 swap plan for ${plan.length} CLEAN-hero products (NO writes performed)\n`);
for (const p of plan) {
  if (p.error) { console.log(`✗ ${p.handle} (${p.id}) — ${p.error}`); continue; }
  const beforePos1 = p.before.find((b) => b.position === 1);
  console.log(`• ${p.title}`);
  console.log(`  handle: ${p.handle} | product ${p.id} | ${p.image_count} images | conf ${p.confidence}`);
  console.log(`  BEFORE pos1: [${beforePos1.image_id}] ${beforePos1.filename}`);
  console.log(`  AFTER  pos1: [${p.hero_image_id}] ${p.after[0].filename}   (was position ${p.hero_current_position})`);
  console.log(`  write: PUT ${p.apply.endpoint}  {image:{id:${p.hero_image_id},position:1}}\n`);
}
console.log(`Plan written: ${outPlan.pathname}`);
process.stderr.write(`\nDONE. ${plan.filter((p) => !p.error).length} ok, ${plan.filter((p) => p.error).length} errors.\n`);
