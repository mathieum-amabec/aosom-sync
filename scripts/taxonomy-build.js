#!/usr/bin/env node
// scripts/taxonomy-build.js
// Reproduces / maintains the outdoor-taxonomy state (plans 5B + 5C).
// IDEMPOTENT: skips products that already carry a tag and smart collections
// whose tag-rule already exists. Safe to re-run.
//
// DRY-RUN BY DEFAULT — prints the plan and writes NOTHING.
// Pass --apply to perform writes.
//
//   node scripts/taxonomy-build.js            # dry run (no writes)
//   node scripts/taxonomy-build.js --apply    # execute writes
//
// What it does:
//   5B  - tag 34 products with "bbq-cuisson" (BBQ-tagged ∪ 7 explicit IDs, − 3 gazebos)
//         rewrite smart collection 314845462633 → tag equals "bbq-cuisson"
//         rewrite smart collection 314845495401 → tag equals "foyer extérieur"
//   5C  - tag members of 5 outdoor collections + create the smart collections:
//         #1 patio-ensemble        (curated: title~"ensemble" + outdoor ctx, minus beds/cushions/nightstands)
//         #2 chaise-table-patio    (members of existing custom 312997806185)
//         #3 gazebo-abri           (members of existing custom 312997707881)
//         #4 jardinage-serre       (members of existing custom 312997740649)
//         #5 rangement-exterieur   (explicit outdoor-storage allow-list)
//   #6 (foyers/chauffage) is intentionally NOT created — 0 net-new heating products,
//      merged into existing "Foyers extérieurs".
//
// NOTE: EN translations are NOT handled here — the token lacks
// read_translations/write_translations/read_locales. See docs/taxonomy-changelog.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadDotenv() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq === -1) continue;
    const k = t.slice(0, eq).trim(); let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const STORE = (process.env.SHOPIFY_STORE_URL || "27u5y2-kp.myshopify.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API = "2025-01";
if (!TOKEN) { console.error("ERROR: SHOPIFY_ACCESS_TOKEN missing"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RL = 550; // ~2 req/sec

async function api(method, endpoint, body) {
  const res = await fetch(`https://${STORE}/admin/api/${API}${endpoint}`, {
    method, headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 429) { await sleep((parseFloat(res.headers.get("Retry-After") || "2")) * 1000); return api(method, endpoint, body); }
  if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status}: ${await res.text()}`);
  const link = res.headers.get("link") || ""; const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return { body: await res.json(), next: m ? new URL(m[1]).searchParams.get("page_info") : null };
}
async function getAll(endpoint, key) {
  const out = []; let pi = null; const sep = endpoint.includes("?") ? "&" : "?";
  do { const ep = pi ? `${endpoint}${sep}page_info=${pi}&limit=250` : `${endpoint}${sep}limit=250`;
    const { body, next } = await api("GET", ep); if (Array.isArray(body[key])) out.push(...body[key]); pi = next; await sleep(200); } while (pi);
  return out;
}
const norm = (s) => String(s || "").toLowerCase();
const tagsOf = (p) => Array.isArray(p.tags) ? p.tags.map(t => String(t).trim()).filter(Boolean) : String(p.tags || "").split(",").map(t => t.trim()).filter(Boolean);

// ── 5B manifest: 34 products to carry "bbq-cuisson" (gazebos excluded) ──
const BBQ_CUISSON_IDS = [
  "7750878167145","7750882852969","7750885179497","7750882033769","7750892748905",
  "7750889963625","7750878134377","7750893666409","7750881280105","7750892683369",
  "7750893600873","7750892814441","7750893437033","7750890061929","7750845726825",
  "7750893404265","7750890848361","7750889996393","7750878265449","7750878036073",
  "7750881804393","7750878068841","7750878298217","7750892879977","7750892716137",
  "7750892781673","7750892847209","7750893076585","7750893502569","7750892945513",
  "7750877544553","7750892912745","7750893633641","7750882558057",
];
// 5C #1 patio-ensemble — the exact 24 curated at apply time (pinned, NOT a live
// matcher: the matcher reads tags, and 5C writes "*-patio" slugs, so a live match drifts).
const PATIO1 = [
  "7793456480361","7798394912873","7750490292329","7750490226793","7751742062697",
  "7788349161577","7752239841385","7736549539945","7736576573545","7736576802921",
  "7752239317097","7736576442473","7736571756649","7736576868457","7736576540777",
  "7798393438313","7736576966761","7736576835689","7736577196137","7736571723881",
  "7736576639081","7736538202217","7752240005225","7736548491369",
];
// 5C explicit outdoor-storage allow-list (#5)
const STORAGE5 = ["7752207269993","7796433289321","7796435746921","7798394880105","7793456447593","7798393864297"];

async function main() {
  console.log(`Taxonomy build — ${STORE} (API ${API}) — ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  const products = await getAll("/products.json?fields=id,title,tags", "products");
  const byId = new Map(products.map(p => [String(p.id), p]));

  // resolve 5C member sets (#1 and #5 pinned; #2/#3/#4 mirror the existing custom collections)
  const set1 = PATIO1;
  const set2 = (await getAll(`/collections/312997806185/products.json?fields=id`, "products")).map(p => String(p.id));
  const set3 = (await getAll(`/collections/312997707881/products.json?fields=id`, "products")).map(p => String(p.id));
  const set4 = (await getAll(`/collections/312997740649/products.json?fields=id`, "products")).map(p => String(p.id));

  // tag → product-id set (5B + 5C combined; one PUT per product, overlap-aware)
  const tagSets = [
    { tag: "bbq-cuisson", ids: BBQ_CUISSON_IDS },
    { tag: "patio-ensemble", ids: set1 },
    { tag: "chaise-table-patio", ids: set2 },
    { tag: "gazebo-abri", ids: set3 },
    { tag: "jardinage-serre", ids: set4 },
    { tag: "rangement-exterieur", ids: STORAGE5 },
  ];
  console.log("Tag sets:");
  for (const ts of tagSets) console.log(`  ${ts.tag.padEnd(20)} ${ts.ids.length} products`);

  const toAdd = new Map(); // id → Set(tag)
  for (const ts of tagSets) for (const id of ts.ids) {
    if (!byId.has(id)) { console.log(`  ⚠ ${id} (${ts.tag}) not found`); continue; }
    if (!toAdd.has(id)) toAdd.set(id, new Set());
    toAdd.get(id).add(ts.tag);
  }

  console.log(`\n=== TAGGING (${toAdd.size} unique products) ===`);
  let put = 0, noop = 0;
  for (const [id, addSet] of toAdd) {
    const current = tagsOf(byId.get(id));
    const lc = new Set(current.map(t => t.toLowerCase()));
    const missing = [...addSet].filter(t => !lc.has(t.toLowerCase()));
    if (missing.length === 0) { noop++; continue; }
    console.log(`     ${APPLY ? "tag" : "would tag"} ${id} += [${missing.join(", ")}]  "${byId.get(id).title}"`);
    if (APPLY) { await api("PUT", `/products/${id}.json`, { product: { id: Number(id), tags: [...current, ...missing].join(", ") } }); await sleep(RL); }
    put++;
  }
  console.log(`  ${APPLY ? "PUT" : "would tag"}: ${put} | already-current: ${noop}`);

  // ── smart collections ──
  const SMART = [
    { tag: "bbq-cuisson", title: "BBQ et articles de cuisson extérieurs", id: "314845462633", published: true },   // 5B rewrite
    { tag: "foyer extérieur", title: "Foyers extérieurs", id: "314845495401", published: true },                    // 5B rewrite
    { tag: "patio-ensemble", title: "Ensembles de patio", published: true },                                         // 5C new
    { tag: "chaise-table-patio", title: "Chaises et tables de patio", published: false },
    { tag: "gazebo-abri", title: "Gazébos, parasols et abris", published: false },
    { tag: "jardinage-serre", title: "Jardinage et serres", published: false },
    { tag: "rangement-exterieur", title: "Rangement extérieur", published: true },
  ];
  console.log(`\n=== SMART COLLECTIONS ===`);
  const existing = await getAll("/smart_collections.json", "smart_collections");
  for (const s of SMART) {
    if (s.id) {
      // existing collection → ensure single tag-equals rule
      const cur = existing.find(c => String(c.id) === s.id);
      const ok = cur && (cur.rules || []).length === 1 && cur.rules[0].column === "tag" && cur.rules[0].relation === "equals" && cur.rules[0].condition === s.tag;
      if (ok) { console.log(`  rewrite ${s.id} "${s.title}" → already tag=="${s.tag}" (noop)`); continue; }
      if (APPLY) { await api("PUT", `/smart_collections/${s.id}.json`, { smart_collection: { id: Number(s.id), rules: [{ column: "tag", relation: "equals", condition: s.tag }], disjunctive: false } }); await sleep(RL); }
      console.log(`  ${APPLY ? "REWROTE" : "would rewrite"} ${s.id} "${s.title}" → tag=="${s.tag}"`);
    } else {
      const dup = existing.find(c => (c.rules || []).some(r => r.column === "tag" && r.relation === "equals" && r.condition === s.tag));
      if (dup) { console.log(`  create "${s.title}" → exists (${dup.id}), skip`); continue; }
      if (APPLY) { const { body } = await api("POST", `/smart_collections.json`, { smart_collection: { title: s.title, rules: [{ column: "tag", relation: "equals", condition: s.tag }], disjunctive: false, published: s.published } }); await sleep(RL); console.log(`  CREATED ${body.smart_collection.id} "${s.title}" (published=${s.published})`); }
      else console.log(`  would create "${s.title}" (published=${s.published})`);
    }
  }

  console.log(`\n${APPLY ? "Applied." : "Dry run complete — no writes. Re-run with --apply to execute."}`);
  console.log(`EN translations NOT handled (token scope). See docs/taxonomy-changelog.md.`);
}
main().catch(e => { console.error("\nFATAL:", e.message); process.exit(1); });
