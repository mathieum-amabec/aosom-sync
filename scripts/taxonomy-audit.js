#!/usr/bin/env node
// scripts/taxonomy-audit.js
// READ-ONLY audit for the outdoor-taxonomy work (plans 5B + 5C).
// Touches NOTHING. GETs only. Reports:
//   1. All collections (smart/custom) with member counts + smart rules
//   2. Tag analysis: BBQ, bbq-cuisson, foyer extérieur, and the 5C slugs
//   3. Membership of the two 5B smart collections
//   4. Translations API readiness (GraphQL scope probe)
//
// Usage: node scripts/taxonomy-audit.js
// Requires: SHOPIFY_STORE_URL + SHOPIFY_ACCESS_TOKEN in .env.local

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

const SLUGS = ["BBQ", "bbq-cuisson", "foyer extérieur", "patio-ensemble", "chaise-table-patio", "gazebo-abri", "jardinage-serre", "rangement-exterieur"];
const SMART_5B = { "314845462633": "BBQ et articles de cuisson", "314845495401": "Foyers extérieurs" };

async function get(endpoint) {
  const res = await fetch(`https://${STORE}/admin/api/${API}${endpoint}`, { headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN } });
  if (res.status === 429) { await new Promise(r => setTimeout(r, (parseFloat(res.headers.get("Retry-After") || "2")) * 1000)); return get(endpoint); }
  if (!res.ok) throw new Error(`GET ${endpoint} → ${res.status}: ${await res.text()}`);
  const link = res.headers.get("link") || ""; const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return { body: await res.json(), next: m ? new URL(m[1]).searchParams.get("page_info") : null };
}
async function getAll(endpoint, key) {
  const out = []; let pi = null; const sep = endpoint.includes("?") ? "&" : "?";
  do { const ep = pi ? `${endpoint}${sep}page_info=${pi}&limit=250` : `${endpoint}${sep}limit=250`;
    const { body, next } = await get(ep); if (Array.isArray(body[key])) out.push(...body[key]); pi = next; } while (pi);
  return out;
}
async function gql(query) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN }, body: JSON.stringify({ query }) });
  return { status: res.status, json: await res.json() };
}
const tagsOf = (p) => Array.isArray(p.tags) ? p.tags.map(t => String(t).trim()).filter(Boolean) : String(p.tags || "").split(",").map(t => t.trim()).filter(Boolean);
const hasTag = (p, t) => tagsOf(p).some(x => x.toLowerCase() === t.toLowerCase());
const bar = (s) => console.log(`\n${"=".repeat(72)}\n  ${s}\n${"=".repeat(72)}`);

async function main() {
  const t0 = Date.now();
  console.log(`Taxonomy audit — ${STORE} (API ${API}) — READ-ONLY, no writes\n`);

  bar("1. COLLECTIONS");
  const smart = await getAll("/smart_collections.json", "smart_collections");
  const custom = await getAll("/custom_collections.json", "custom_collections");
  const all = [...smart.map(c => ({ ...c, _t: "smart" })), ...custom.map(c => ({ ...c, _t: "custom" }))];
  for (const c of all) c._cnt = (await get(`/products/count.json?collection_id=${c.id}`)).body.count;
  all.sort((a, b) => a._t.localeCompare(b._t) || a.title.localeCompare(b.title));
  console.log(`  smart: ${smart.length} | custom: ${custom.length} | total: ${all.length}\n`);
  for (const c of all) {
    console.log(`  [${c._t.padEnd(6)}] ${String(c.id).padEnd(14)} ${String(c._cnt).padStart(4)}  ${c.title}`);
    if (c._t === "smart") for (const r of c.rules || []) console.log(`            rule: ${r.column} ${r.relation} "${r.condition}"`);
  }

  bar("2. TAG ANALYSIS");
  const products = await getAll("/products.json?fields=id,title,tags", "products");
  console.log(`  total products: ${products.length}\n`);
  for (const slug of SLUGS) console.log(`  "${slug}": ${products.filter(p => hasTag(p, slug)).length}`);

  bar("3. 5B SMART COLLECTION MEMBERS");
  for (const [id, label] of Object.entries(SMART_5B)) {
    const ms = await getAll(`/collections/${id}/products.json?fields=id,title`, "products");
    console.log(`\n  ${label} (${id}): ${ms.length} members`);
    for (const m of ms) console.log(`     ${String(m.id).padEnd(16)} ${m.title}`);
  }

  bar("4. TRANSLATIONS API READINESS");
  const loc = await gql(`{ shopLocales { locale primary published } }`);
  if (loc.json.errors) console.log(`  shopLocales: DENIED — ${loc.json.errors[0].extensions?.requiredAccess || loc.json.errors[0].message}`);
  else console.log(`  shopLocales: ${(loc.json.data.shopLocales || []).map(l => l.locale).join(", ")}`);
  const tr = await gql(`{ translatableResource(resourceId: "gid://shopify/Collection/314845462633") { translatableContent { key } } }`);
  if (tr.json.errors) console.log(`  translatableResource: DENIED — ${tr.json.errors[0].extensions?.requiredAccess || tr.json.errors[0].message}`);
  else console.log(`  translatableResource: OK (read_translations present)`);

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. READ-ONLY. Nothing modified.`);
}
main().catch(e => { console.error("\nFATAL:", e.message); process.exit(1); });
