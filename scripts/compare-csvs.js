#!/usr/bin/env node
// scripts/compare-csvs.js
// Compare the original export against the modified one to see exactly what changed.
// Also cross-references against the current live state from diagnose-shopify.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const ORIGINAL = path.join(repoRoot, "data/shopify-backup/original.csv");
const MODIFIED = path.join(repoRoot, "data/shopify-backup/modified.csv");

function readCsv(file) {
  const content = fs.readFileSync(file, "utf8");
  // Auto-detect delimiter from the first line: whichever of ; or , appears more often wins.
  const firstLine = content.split(/\r?\n/)[0] || "";
  const semis = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delimiter = semis > commas ? ";" : ",";
  return parse(content, {
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });
}

function byHandle(rows) {
  // Shopify exports one row per variant, first row per handle has the product fields
  const map = new Map();
  for (const row of rows) {
    const h = row.Handle;
    if (!h) continue;
    if (!map.has(h)) {
      map.set(h, {
        handle: h,
        title: row.Title,
        published: row.Published,
        status: row.Status,
        vendor: row.Vendor,
        type: row.Type,
        category: row["Product Category"],
        tags: row.Tags,
      });
    }
  }
  return map;
}

function countBy(map, field) {
  const counts = {};
  for (const p of map.values()) {
    const v = p[field] || "(empty)";
    counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

const orig = readCsv(ORIGINAL);
const mod = readCsv(MODIFIED);
const origProducts = byHandle(orig);
const modProducts = byHandle(mod);

console.log(`\nOriginal: ${orig.length} rows, ${origProducts.size} unique products`);
console.log(`Modified: ${mod.length} rows, ${modProducts.size} unique products\n`);

console.log("=== PUBLISHED column ===");
console.log("original:", countBy(origProducts, "published"));
console.log("modified:", countBy(modProducts, "published"));

console.log("\n=== STATUS column ===");
console.log("original:", countBy(origProducts, "status"));
console.log("modified:", countBy(modProducts, "status"));

console.log("\n=== Per-product diff (first 15) ===");
const diffList = [];
for (const [handle, origP] of origProducts) {
  const modP = modProducts.get(handle);
  if (!modP) {
    diffList.push({ handle, change: "REMOVED", title: origP.title });
    continue;
  }
  const changes = [];
  if (origP.published !== modP.published) changes.push(`published: ${origP.published} → ${modP.published}`);
  if (origP.status !== modP.status) changes.push(`status: ${origP.status} → ${modP.status}`);
  if (origP.tags !== modP.tags) changes.push(`tags: changed`);
  if (changes.length > 0) {
    diffList.push({ handle, change: changes.join(" | "), title: origP.title });
  }
}
for (const [handle, modP] of modProducts) {
  if (!origProducts.has(handle)) {
    diffList.push({ handle, change: "ADDED", title: modP.title });
  }
}

console.log(`Total products with differences: ${diffList.length}`);
for (const d of diffList.slice(0, 15)) {
  console.log(`  ${d.handle.padEnd(40)} ${d.change}  (${(d.title || "").slice(0, 40)})`);
}
if (diffList.length > 15) console.log(`  ... and ${diffList.length - 15} more`);

// Export the handles-to-restore list for the restore script
const restoreList = [];
for (const [handle, origP] of origProducts) {
  if ((origP.published || "").toUpperCase() === "TRUE") {
    restoreList.push({ handle, title: origP.title });
  }
}
const outPath = path.join(repoRoot, "data/shopify-backup/should-be-published.json");
fs.writeFileSync(outPath, JSON.stringify(restoreList, null, 2));
console.log(`\nWrote ${restoreList.length} handles that were Published=TRUE in the ORIGINAL export to:`);
console.log(`  ${outPath}`);
console.log("These are the products that should currently be visible on the store.");
