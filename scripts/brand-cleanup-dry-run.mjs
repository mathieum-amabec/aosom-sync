// Chantier A1 — DRY-RUN ONLY (no writes whatsoever).
//
// Scans every Shopify product and reports the ones whose TITLE still contains an
// Aosom house-brand token (Outsunny, HOMCOM, Aosom, Vinsetto, Kleankin, Zonekiz +
// the rest of the Aosom family). Produces docs/brand-cleanup-dry-run.csv with the
// proposed cleaned title and proposed vendor, so Mat can validate before any write.
//
// Rules:
//   - remove the brand token from the title
//   - collapse double spaces, orphan dashes and double commas left behind
//   - keep the existing "Type, caractéristique, taille — couleur" structure (no reorder)
//   - the brand belongs in the `vendor` field only (proposed_vendor = detected brand)
//   - HANDLES ARE NEVER TOUCHED (feed risk) — not even read into the change set
//
// Run:  node scripts/brand-cleanup-dry-run.mjs
// Reads Shopify creds from .env.local via _shopify-lib.mjs. Read-only Admin GraphQL.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gql, sleep } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

console.log("Scanning Shopify catalog (read-only)…\n");

let cursor = null, total = 0, pages = 0;
const rows = [];

while (true) {
  const { data } = await gql(Q, { cursor });
  pages++;
  for (const p of data.products.nodes) {
    total++;
    if (!detectRe.test(p.title)) continue;
    const brand = detectBrand(p.title);
    const cleaned = cleanTitle(p.title);
    rows.push({
      product_id: p.legacyResourceId,
      marque_detectee: brand,
      ancien_titre: p.title,
      titre_nettoye_propose: cleaned,
      vendor_actuel: p.vendor || "",
      // The brand lives in `vendor` only. Keep "Aosom" when the leaked token *is* the
      // supplier itself; otherwise propose the specific house brand.
      vendor_propose: brand && brand.toLowerCase() === "aosom" ? (p.vendor || "Aosom") : brand,
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
const outPath = join(outDir, "brand-cleanup-dry-run.csv");
writeFileSync(outPath, csv, "utf8");

// ---- Console report ----
console.log(`Scanned ${total} products across ${pages} page(s).`);
console.log(`Titles still containing a supplier brand: ${rows.length}\n`);
console.log("SAMPLE (first 20):");
console.log("─".repeat(80));
for (const r of rows.slice(0, 20)) {
  console.log(`#${r.product_id}  [${r.marque_detectee}]  vendor ${r.vendor_actuel} -> ${r.vendor_propose}`);
  console.log(`   avant : ${r.ancien_titre}`);
  console.log(`   après : ${r.titre_nettoye_propose}`);
}
console.log("─".repeat(80));
console.log(`\nTOTAL à corriger : ${rows.length}`);
console.log(`CSV écrit : docs/brand-cleanup-dry-run.csv  (${rows.length} lignes)`);
console.log("\nDRY-RUN — aucune écriture effectuée. En attente de validation de Mat.");
