// Chantier A1 — supplier-brand removal from product TITLES.
//
// DEFAULT = DRY-RUN (no writes). Pass --apply to perform the title updates.
//
// Scans every Shopify product and reports the ones whose TITLE still contains an
// Aosom house-brand token (Outsunny, HOMCOM, Aosom, Vinsetto, Kleankin, Zonekiz +
// the rest of the Aosom family). Writes docs/brand-cleanup-dry-run.csv.
//
// Rules (validated by Mat 2026-06-10):
//   - remove the brand token from the title
//   - collapse double spaces, orphan dashes and double commas left behind
//   - keep the existing "Type, caractéristique, taille — couleur" structure (no reorder)
//   - VENDOR IS LEFT UNCHANGED ("Aosom" for all) — we only strip the brand from the title
//   - HANDLES ARE NEVER TOUCHED (feed risk) — not even read into the change set
//
// Run (dry-run):  node scripts/brand-cleanup-dry-run.mjs
// Run (apply):    node scripts/brand-cleanup-dry-run.mjs --apply
// Reads Shopify creds from .env.local via _shopify-lib.mjs.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gql, sleep } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

// Mat's six + the remaining Aosom house brands ("toute autre marque Aosom").
// Only confirmed Aosom-owned brands — NOT third-party makers (e.g. Teamson is a
// separate company, deliberately excluded to avoid stripping a non-Aosom brand).
const BRANDS = [
  "Outsunny", "HOMCOM", "Aosom", "Vinsetto", "Kleankin", "Zonekiz",
  "Soozier", "Qaba", "PawHut", "Sportnow", "Aiyaplay", "Rosefray",
];
const CANON = new Map(BRANDS.map((b) => [b.toLowerCase(), b]));
// Word-boundary, case-insensitive. Longest-first so multi-token names match whole.
const ordered = [...BRANDS].sort((a, b) => b.length - a.length);
const detectRe = new RegExp("\\b(" + ordered.join("|") + ")\\b", "i");
const stripRe = new RegExp("\\b(" + ordered.join("|") + ")\\b", "gi");

function cleanTitle(title) {
  let t = title.replace(stripRe, "");
  t = t.replace(/\s+/g, " ");                       // collapse whitespace
  t = t.replace(/\s*,\s*,\s*/g, ", ");              // ", ," left by a removed brand
  t = t.replace(/\s+,/g, ",").replace(/,(?=\S)/g, ", "); // tidy comma spacing
  // Only collapse *separator* dashes (whitespace on a side). A word-joining hyphen
  // like "Brise-Vue" has no surrounding spaces and must stay intact.
  t = t.replace(/(?:\s[–—-]){2,}\s/g, " — ");       // doubled separator dashes -> one
  t = t.replace(/\s+/g, " ");
  t = t.replace(/^[\s,–—-]+/, "");                  // strip leading orphan separators
  t = t.replace(/[\s,–—-]+$/, "");                  // strip trailing orphan separators
  return t.trim();
}

function detectBrand(title) {
  const m = title.match(detectRe);
  if (!m) return null;
  return CANON.get(m[1].toLowerCase()) || m[1]; // canonical casing (OUTSUNNY -> Outsunny)
}

const Q = `query($cursor: String){
  products(first: 250, after: $cursor){
    pageInfo{ hasNextPage endCursor }
    nodes{ id legacyResourceId title vendor }
  }
}`;

console.log(`Scanning Shopify catalog (${APPLY ? "APPLY MODE" : "read-only"})…\n`);

let cursor = null, total = 0, pages = 0;
const rows = [];

while (true) {
  const { data } = await gql(Q, { cursor });
  pages++;
  for (const p of data.products.nodes) {
    total++;
    if (!detectRe.test(p.title)) continue;
    rows.push({
      gid: p.id,
      product_id: p.legacyResourceId,
      marque_detectee: detectBrand(p.title),
      ancien_titre: p.title,
      titre_nettoye_propose: cleanTitle(p.title),
      vendor_actuel: p.vendor || "",
      vendor_propose: p.vendor || "", // unchanged — Mat: vendor stays "Aosom"
    });
  }
  if (!data.products.pageInfo.hasNextPage) break;
  cursor = data.products.pageInfo.endCursor;
  await sleep(550); // ~2 req/sec
}

// ---- CSV (UTF-8 BOM so Excel on Windows renders accents) ----
const headers = [
  "product_id", "marque_detectee", "ancien_titre",
  "titre_nettoye_propose", "vendor_actuel", "vendor_propose",
];
const esc = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = "﻿" + [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\r\n") + "\r\n";

const outDir = join(__dirname, "..", "docs");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "brand-cleanup-dry-run.csv"), csv, "utf8");

// ---- Console report ----
console.log(`Scanned ${total} products across ${pages} page(s).`);
console.log(`Titles still containing a supplier brand: ${rows.length}\n`);
console.log("SAMPLE (first 20):");
console.log("─".repeat(80));
for (const r of rows.slice(0, 20)) {
  console.log(`#${r.product_id}  [strip ${r.marque_detectee}]  (vendor ${r.vendor_actuel} — unchanged)`);
  console.log(`   avant : ${r.ancien_titre}`);
  console.log(`   après : ${r.titre_nettoye_propose}`);
}
console.log("─".repeat(80));
console.log(`\nTOTAL à corriger : ${rows.length}`);
console.log(`CSV écrit : docs/brand-cleanup-dry-run.csv  (${rows.length} lignes)`);

if (!APPLY) {
  console.log("\nDRY-RUN — aucune écriture effectuée. Relancer avec --apply pour écrire les titres.");
  process.exit(0);
}

// ---- APPLY: title-only update (vendor untouched) ----
console.log("\n--apply : mise à jour des titres (vendor inchangé)…\n");
const M = `mutation($input: ProductInput!){
  productUpdate(input: $input){ product { legacyResourceId title } userErrors { field message } }
}`;
let ok = 0, fail = 0;
for (const r of rows) {
  if (r.titre_nettoye_propose === r.ancien_titre) { console.log(`skip #${r.product_id} (no change)`); continue; }
  if (!r.titre_nettoye_propose) { console.log(`SKIP #${r.product_id} (empty cleaned title!)`); fail++; continue; }
  try {
    const { data } = await gql(M, { input: { id: r.gid, title: r.titre_nettoye_propose } });
    const errs = data.productUpdate.userErrors;
    if (errs.length) { console.log(`FAIL #${r.product_id}: ${JSON.stringify(errs)}`); fail++; }
    else { console.log(`OK   #${r.product_id}: ${data.productUpdate.product.title}`); ok++; }
  } catch (e) { console.log(`FAIL #${r.product_id}: ${e.message}`); fail++; }
  await sleep(550);
}
console.log(`\nApply terminé : ${ok} OK, ${fail} échec(s).`);
