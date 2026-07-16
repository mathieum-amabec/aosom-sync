// Create priority-1/2 smart collections (Salon / Cuisine / Chambre) to add sub-category
// granularity to the "fourre-tout" Meubles collections. Mirrors the existing smart-collection
// taxonomy (rule = `type contains "<Aosom product_type path>"`).
//
// DRY-RUN by default: prints FR title, handle, rule(s), and the LIVE product count per rule
// (from Turso) — sends NOTHING. --apply POSTs to Shopify /smart_collections.json (skips a
// handle that already exists). Rules are ANCHORED on the parent path to avoid leaf collisions
// (e.g. "Kitchen & Dining Furniture > Dining Tables" won't catch "Patio Dining Tables").
//
//   node-x64 scripts/create-smart-collections.mjs           (dry-run)
//   node-x64 scripts/create-smart-collections.mjs --apply   (create, after Mat's approval)

import { readFileSync } from "node:fs";
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const APPLY = process.argv.includes("--apply");
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) { let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v = v.slice(1,-1); env[m[1]] = v; } }
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// title, handle, [rule conditions], disjunctive(OR) if >1
const COLLECTIONS = [
  { g: "SALON", title: "Causeuses", handle: "salon-causeuses", rules: ["Sofas & Reclining Chairs > 2-Seater Sofas"] },
  { g: "SALON", title: "Fauteuils d'appoint", handle: "salon-fauteuils-appoint", rules: ["Sofas & Reclining Chairs > Accent Chairs"] },
  { g: "SALON", title: "Tables basses", handle: "salon-tables-basses", rules: ["Living Room Furniture > Coffee Tables"] },
  { g: "SALON", title: "Canapés 3 places", handle: "salon-canapes-3-places", rules: ["Sofas & Reclining Chairs > 3-Seater Sofas"] },
  { g: "SALON", title: "Meubles pour téléviseur", handle: "salon-meubles-tv", rules: ["Living Room Furniture > TV Stands"] },
  { g: "SALON", title: "Sectionnels", handle: "salon-sectionnels", rules: ["Sofas & Reclining Chairs > L Shaped Couchs"] },
  { g: "SALON", title: "Tables console", handle: "salon-tables-console", rules: ["Living Room Furniture > Console Tables"] },
  { g: "SALON", title: "Cloisons & paravents", handle: "salon-cloisons-paravents", rules: ["Living Room Furniture > Room Dividers"] },

  { g: "CUISINE", title: "Tabourets de bar", handle: "cuisine-tabourets-bar", rules: ["Kitchen & Dining Furniture > Bar Stools"] },
  { g: "CUISINE", title: "Chaises de salle à manger", handle: "cuisine-chaises-salle-a-manger", rules: ["Kitchen & Dining Furniture > Dining Chairs"] },
  { g: "CUISINE", title: "Tables de salle à manger", handle: "cuisine-tables-a-manger", rules: ["Kitchen & Dining Furniture > Dining Tables"] },
  { g: "CUISINE", title: "Bars & cabinets de bar", handle: "cuisine-bars-cabinets", rules: ["Kitchen & Dining Furniture > Bar Cabinets"] },
  { g: "CUISINE", title: "Îlots & chariots de cuisine", handle: "cuisine-ilots-chariots", rules: ["Kitchen Islands & Kitchen Carts"] },
  { g: "CUISINE", title: "Ensembles table et chaises", handle: "cuisine-ensembles-table-chaises", rules: ["Kitchen & Dining Furniture > Dining Table Sets"] },

  { g: "CHAMBRE", title: "Tables de chevet", handle: "chambre-tables-de-chevet", rules: ["Bedroom Furniture > Bedside Tables"] },
  { g: "CHAMBRE", title: "Coiffeuses", handle: "chambre-coiffeuses", rules: ["Bedroom Furniture > Dressing & Vanity Tables"] },
  { g: "CHAMBRE", title: "Miroirs", handle: "chambre-miroirs", rules: ["Bedroom Furniture > Full Length Mirrors", "Bedroom Furniture > Wall Mirrors"] },
  { g: "CHAMBRE", title: "Matelas", handle: "chambre-matelas", rules: ["Bedding & Bath > Mattresses"] },
  { g: "CHAMBRE", title: "Cadres et bases de lit", handle: "chambre-bases-de-lit", rules: ["Bedroom Furniture > Bed Frames"] },
];

// ── Resolve each intended (normal-space) substring to the EXACT stored product_type
// strings. Aosom's feed embeds non-breaking spaces (U+00A0) in some types (e.g. "TV Stands",
// "Console Tables", "Room Dividers"); a rule with a normal space matches nothing in Turso OR
// Shopify. Normalizing nbsp→space for the LOOKUP, but using the verbatim stored string as the
// rule CONDITION, makes both sides match. ──
const { createClient } = await import("@libsql/client");
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
async function resolve(rules) {
  const conditions = new Set();
  let hadNbsp = false;
  for (const intended of rules) {
    const rows = await db.execute({
      sql: `SELECT DISTINCT product_type FROM products
             WHERE shopify_product_id IS NOT NULL
               AND REPLACE(product_type, char(160), ' ') LIKE ?`,
      args: [`%${intended}%`],
    });
    for (const row of rows.rows) {
      const t = String(row.product_type);
      if (t.includes(" ")) hadNbsp = true;
      conditions.add(t);
    }
  }
  const conds = [...conditions];
  // count of distinct products matching ANY resolved exact type
  let count = 0;
  if (conds.length) {
    const where = conds.map(() => "product_type = ?").join(" OR ");
    const r = await db.execute({ sql: `SELECT COUNT(*) c FROM products WHERE shopify_product_id IS NOT NULL AND (${where})`, args: conds });
    count = Number(r.rows[0].c) || 0;
  }
  return { conditions: conds, count, hadNbsp };
}
for (const c of COLLECTIONS) { const r = await resolve(c.rules); c.conditions = r.conditions; c.count = r.count; c.hadNbsp = r.hadNbsp; }
await db.close?.();

// ── Shopify helpers ──
async function shopify(path, { method = "GET", body } = {}) {
  await sleep(550);
  const init = { method, headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  const r = await fetch(`https://${STORE}/admin/api/${API}/${path}`, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return d;
}
function payload(c) {
  // Rule condition = the EXACT stored product_type string(s) resolved from the DB (nbsp
  // preserved), so Shopify `contains` matches the same products the Turso count found.
  return { smart_collection: {
    title: c.title, handle: c.handle,
    rules: c.conditions.map(cond => ({ column: "type", relation: "contains", condition: cond })),
    disjunctive: c.conditions.length > 1,
    published: true,
  } };
}

// ── output ──
let group = "";
let total = 0;
for (const c of COLLECTIONS) {
  if (c.g !== group) { group = c.g; console.log(`\n════════ ${group} ════════`); }
  total += c.count;
  const nb = c.conditions.some(x => x.includes(String.fromCharCode(160))) ? "  ⟵ contient un espace insécable (nbsp) — préservé dans la règle" : "";
  console.log(`\n  ${c.title}   [handle: ${c.handle}]   → ~${c.count} produits${c.count === 0 ? "  ⚠ VIDE — ne sera PAS créée" : ""}`);
  const pl = payload(c).smart_collection;
  for (const p of pl.rules) console.log(`     rule: type contains "${p.condition.replace(new RegExp(String.fromCharCode(160), "g"), "␣")}"${pl.disjunctive ? "  (OR)" : ""}${nb}`);
}
console.log(`\n──────── ${COLLECTIONS.length} collections, ~${total} produits couverts (chevauchements possibles) ────────`);

if (!APPLY) {
  console.log(`\n=== exemple payload Shopify (1re collection) ===`);
  console.log(JSON.stringify(payload(COLLECTIONS[0]), null, 2));
  console.log(`\n⚠ Matelas: crée la collection "chambre-matelas" MAIS ne retire pas les matelas de`);
  console.log(`  "Salle de bain" (475651014761, règle type contains "Home Furnishings > Bedding & Bath").`);
  console.log(`  Pour les sortir: éditer cette règle → ajouter "type not_contains Mattresses" (étape séparée).`);
  console.log(`\n── DRY RUN — rien créé. Re-lancer avec --apply après approbation. ──`);
  process.exit(0);
}

// ── APPLY ──
console.log("\nPreflight: existing smart collection handles …");
const existing = new Set();
{ let pi = null; do {
  const params = new URLSearchParams({ limit: "250", fields: "handle" }); if (pi) params.set("page_info", pi);
  const r = await fetch(`https://${STORE}/admin/api/${API}/smart_collections.json?${params}`, { headers: { "X-Shopify-Access-Token": TOKEN } });
  const d = await r.json(); (d.smart_collections || []).forEach(s => existing.add(s.handle));
  const link = r.headers.get("Link"); const m = link && link.split(",").find(s => s.includes('rel="next"')); const mm = m && /<([^>]+)>/.exec(m);
  pi = mm ? new URL(mm[1]).searchParams.get("page_info") : null; await sleep(550);
} while (pi); }
// live product count of a collection (smart membership is computed by Shopify)
async function collCount(id) {
  const d = await shopify(`products/count.json?collection_id=${id}`);
  return d.count;
}

const created = [];
console.log(`\nCreating ${COLLECTIONS.length} smart collections …`);
for (const c of COLLECTIONS) {
  if (c.conditions.length === 0 || c.count === 0) { console.log(`  SKIP ${c.handle} (empty — 0 products)`); continue; }
  if (existing.has(c.handle)) { console.log(`  SKIP ${c.handle} (exists)`); continue; }
  const res = await shopify("smart_collections.json", { method: "POST", body: payload(c) });
  const id = res.smart_collection?.id;
  const cnt = await collCount(id);
  created.push({ g: c.g, title: c.title, handle: c.handle, id, count: cnt });
  console.log(`  ✓ ${String(c.g).padEnd(7)} id=${id}  count=${String(cnt).padStart(3)}  ${c.handle}  "${c.title}"`);
}

// ── Matelas step: remove Mattresses from the existing "Salle de bain" (475651014761) ──
const SDB_ID = "475651014761";
const EXCL = { column: "type", relation: "not_contains", condition: "Mattresses" };
console.log(`\n── Matelas step: excluding Mattresses from "Salle de bain" (${SDB_ID}) ──`);
const before = await collCount(SDB_ID);
const sdb = (await shopify(`smart_collections/${SDB_ID}.json`)).smart_collection;
const rules = sdb.rules || [];
const already = rules.some(r => r.relation === "not_contains" && /Mattresses/i.test(r.condition));
if (already) {
  console.log(`  already excludes Mattresses — no change. count=${before}`);
} else {
  const newRules = [...rules, EXCL];
  await shopify(`smart_collections/${SDB_ID}.json`, { method: "PUT", body: { smart_collection: { id: Number(SDB_ID), rules: newRules, disjunctive: false } } });
  const after = await collCount(SDB_ID);
  console.log(`  rules: ${rules.map(r=>`${r.relation} "${r.condition}"`).join(" AND ")}  →  + not_contains "Mattresses"`);
  console.log(`  "Salle de bain" count: ${before} → ${after}  (removed ${before - after} mattress products)`);
}

// ── final report ──
console.log(`\n════════ RAPPORT FINAL ════════`);
console.log(`Collections créées: ${created.length}/${COLLECTIONS.length}`);
let g = "";
for (const c of created) { if (c.g !== g) { g = c.g; console.log(`\n  ${g}`); } console.log(`    id=${c.id}  count=${String(c.count).padStart(3)}  ${c.handle}  "${c.title}"`); }
console.log(`\n  Total produits couverts (somme, chevauchements possibles): ${created.reduce((s,c)=>s+c.count,0)}`);
console.log("\n✓ Done.");
