// Batch 2 smart collections: orphan splits (Salon/Cuisine) + Rangement + Salle de bain +
// Bureau + Patio P3. Same nbsp-safe resolver as batch 1 (rule = exact stored product_type).
// DRY-RUN by default (prints title/handle/rule + LIVE and TOTAL-catalog counts); --apply POSTs.
// Skips handles that already exist and empty (0-total) collections.
//
//   node-x64 scripts/create-smart-collections-batch2.mjs           (dry-run)
//   node-x64 scripts/create-smart-collections-batch2.mjs --apply

import { readFileSync } from "node:fs";
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const APPLY = process.argv.includes("--apply");
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = {};
for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) { let v = m[2].trim(); if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v = v.slice(1,-1); env[m[1]] = v; } }
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// g=group, title, handle, rules=[intended substrings], note=overlap flag
const COLLECTIONS = [
  { g: "SALON", title: "Tables d'appoint", handle: "salon-tables-appoint", rules: ["Living Room Furniture > Side Tables"] },
  { g: "SALON", title: "Canapés simples", handle: "salon-canapes-simples", rules: ["Sofas & Reclining Chairs > Single Sofas"] },
  { g: "SALON", title: "Fauteuils releveurs électriques", handle: "salon-fauteuils-releveurs", rules: ["Sofas & Reclining Chairs > Electric Power Lift Chairs"] },

  { g: "CUISINE", title: "Tables de bar", handle: "cuisine-tables-bar", rules: ["Kitchen & Dining Furniture > Bar Tables"] },
  { g: "CUISINE", title: "Ensembles de bar", handle: "cuisine-ensembles-bar", rules: ["Kitchen & Dining Furniture > Bar Sets"] },

  { g: "RANGEMENT", title: "Range-chaussures", handle: "rangement-range-chaussures", rules: ["Storage & Organization > Shoe Storage Cabinets & Racks"] },
  { g: "RANGEMENT", title: "Garde-manger", handle: "rangement-garde-manger", rules: ["Storage & Organization > Kitchen Pantry Cabinets"] },
  { g: "RANGEMENT", title: "Armoires de rangement", handle: "rangement-armoires", rules: ["Storage & Organization > Storage Cabinets"] },
  { g: "RANGEMENT", title: "Poufs & bancs de rangement", handle: "rangement-poufs-bancs", rules: ["Storage Ottomans & Benches"] },
  { g: "RANGEMENT", title: "Bibliothèques", handle: "rangement-bibliotheques", rules: ["Bookshelves & Bookcases"] },
  { g: "RANGEMENT", title: "Penderies", handle: "rangement-penderies", rules: ["Storage & Organization > Clothing Storage"] },

  { g: "SALLE DE BAIN", title: "Armoires sur pied", handle: "sdb-armoires-sur-pied", rules: ["Bathroom Cabinets > Freestanding Bathroom Cabinets"] },
  { g: "SALLE DE BAIN", title: "Armoires à pharmacie & miroirs", handle: "sdb-armoires-pharmacie", rules: ["Bedding & Bath > Mirror Medicine Cabinets"] },
  { g: "SALLE DE BAIN", title: "Armoires murales", handle: "sdb-armoires-murales", rules: ["Bathroom Cabinets > Wall Mounted Cabinets"] },

  { g: "BUREAU", title: "Chaises de travail", handle: "bureau-chaises-travail", rules: ["Office Chairs > Task Chairs"] },
  { g: "BUREAU", title: "Bureaux d'ordinateur", handle: "bureau-bureaux-ordinateur", rules: ["Office Desks & Work Stations > Computer Desks"] },
  { g: "BUREAU", title: "Fauteuils de bureau massants", handle: "bureau-fauteuils-massants", rules: ["Office Chairs > Massage Chairs"] },
  { g: "BUREAU", title: "Bureaux d'écriture", handle: "bureau-bureaux-ecriture", rules: ["Office Desks & Work Stations > Writing Desks"] },

  // Chaises longues & transats OMIS: chevauche l'existant patio-chaises-longues (parent Sun Loungers).
  { g: "PATIO", title: "Bacs surélevés galvanisés", handle: "patio-bacs-galvanises", rules: ["Raised Garden Beds > Galvanized Planter Boxes"] },
  { g: "PATIO", title: "Parasols droits", handle: "patio-parasols-droits", rules: ["Patio Umbrellas > Sun Umbrellas"] },
  { g: "PATIO", title: "Bases de parasol", handle: "patio-bases-parasol", rules: ["Patio Umbrellas > Umbrella Bases"] },
  { g: "PATIO", title: "Parasols déportés", handle: "patio-parasols-deportes", rules: ["Patio Umbrellas > Offset Cantilever Umbrellas"] },
  { g: "PATIO", title: "Gazébos toit souple", handle: "patio-gazebos-toit-souple", rules: ["Gazebos > Soft Top Gazebos"] },
  { g: "PATIO", title: "Gazébos toit rigide", handle: "patio-gazebos-toit-rigide", rules: ["Gazebos > Hardtop Gazebos"] },
  { g: "PATIO", title: "Remises de jardin", handle: "patio-remises-jardin", rules: ["Lawn & Garden > Sheds"] },
  // Foyers extérieurs OMIS: existe déjà comme smart collection "exterieur-foyers" (Patio & Garden > Fire Pits).
];

const { createClient } = await import("@libsql/client");
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
async function resolve(rules) {
  const conditions = new Set();
  for (const intended of rules) {
    const rows = await db.execute({
      sql: `SELECT DISTINCT product_type FROM products WHERE product_type IS NOT NULL AND REPLACE(product_type, char(160), ' ') LIKE ?`,
      args: [`%${intended}%`],
    });
    for (const row of rows.rows) conditions.add(String(row.product_type));
  }
  const conds = [...conditions];
  let live = 0, total = 0;
  if (conds.length) {
    const where = conds.map(() => "product_type = ?").join(" OR ");
    total = Number((await db.execute({ sql: `SELECT COUNT(*) c FROM products WHERE ${where}`, args: conds })).rows[0].c) || 0;
    live = Number((await db.execute({ sql: `SELECT COUNT(*) c FROM products WHERE shopify_product_id IS NOT NULL AND (${where})`, args: conds })).rows[0].c) || 0;
  }
  return { conditions: conds, live, total };
}
for (const c of COLLECTIONS) { const r = await resolve(c.rules); c.conditions = r.conditions; c.live = r.live; c.total = r.total; }
await db.close?.();

async function shopify(path, { method = "GET", body } = {}) {
  await sleep(550);
  const init = { method, headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  const r = await fetch(`https://${STORE}/admin/api/${API}/${path}`, init);
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(d).slice(0,300)}`); return d;
}
const payload = (c) => ({ smart_collection: { title: c.title, handle: c.handle, rules: c.conditions.map(cond => ({ column: "type", relation: "contains", condition: cond })), disjunctive: c.conditions.length > 1, published: true } });
const vis = (s) => s.replace(new RegExp(String.fromCharCode(160), "g"), "␣");

// ── output ──
let group = "", tl = 0, tt = 0;
for (const c of COLLECTIONS) {
  if (c.g !== group) { group = c.g; console.log(`\n════════ ${group} ════════`); }
  tl += c.live; tt += c.total;
  console.log(`\n  ${c.title}   [${c.handle}]   → live ${c.live} / catalogue ${c.total}${c.total===0?"  ⚠ VIDE":""}${c.note?`\n     ⚠ ${c.note}`:""}`);
  for (const cond of c.conditions) console.log(`     rule: type contains "${vis(cond)}"${c.conditions.length>1?"  (OR)":""}`);
}
console.log(`\n──────── ${COLLECTIONS.length} collections — live ${tl} / catalogue ${tt} ────────`);

if (!APPLY) {
  console.log(`\n── DRY RUN — rien créé. --apply après ton go. ──`);
  process.exit(0);
}
// APPLY
const existing = new Set();
{ let pi=null; do { const params=new URLSearchParams({limit:"250",fields:"handle"}); if(pi)params.set("page_info",pi);
  const r=await fetch(`https://${STORE}/admin/api/${API}/smart_collections.json?${params}`,{headers:{"X-Shopify-Access-Token":TOKEN}});
  const d=await r.json(); (d.smart_collections||[]).forEach(s=>existing.add(s.handle));
  const link=r.headers.get("Link"); const m=link&&link.split(",").find(s=>s.includes('rel="next"')); const mm=m&&/<([^>]+)>/.exec(m);
  pi=mm?new URL(mm[1]).searchParams.get("page_info"):null; await sleep(550);
} while(pi); }
const created = [];
for (const c of COLLECTIONS) {
  if (c.total === 0 || c.conditions.length === 0) { console.log(`  SKIP ${c.handle} (empty)`); continue; }
  if (existing.has(c.handle)) { console.log(`  SKIP ${c.handle} (exists)`); continue; }
  const res = await shopify("smart_collections.json", { method: "POST", body: payload(c) });
  const id = res.smart_collection?.id;
  const cnt = (await shopify(`products/count.json?collection_id=${id}`)).count;
  created.push({ ...c, id, count: cnt });
  console.log(`  ✓ ${String(c.g).padEnd(13)} id=${id}  live=${String(cnt).padStart(3)}  ${c.handle}`);
}
console.log(`\n✓ Créées: ${created.length}/${COLLECTIONS.length}`);
