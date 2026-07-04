// Build the consolidated catalog status: lifestyle-catalog-status-complete.csv
// Columns: shopify_product_id, handle, title, has_clean_lifestyle_pos1, status
// Sources: catalog-all-products.json + lifestyle-catalog-map.json buckets +
//          lifestyle-classification-304.checkpoint.jsonl (the reclassified 304).
import { readFileSync, writeFileSync } from "node:fs";
const all = JSON.parse(readFileSync(new URL("../catalog-all-products.json", import.meta.url), "utf8"));
const map = JSON.parse(readFileSync(new URL("../lifestyle-catalog-map.json", import.meta.url), "utf8"));
const b = map.buckets;
const executedClean = new Set(b.executed_clean.map(String));
const swapText = new Set(b.swap_text.map(String));
const still = new Set(b.still_no_lifestyle.map(String));
const c304 = new Map();
for (const l of readFileSync(new URL("../lifestyle-classification-304.checkpoint.jsonl", import.meta.url), "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); c304.set(String(o.detail.id), o.detail.action); } catch {} }

function classify(id) {
  id = String(id);
  if (executedClean.has(id)) return { clean: true, status: "CLEAN_POS1" };
  const a304 = c304.get(id);
  if (a304) {
    if (a304 === "SWAP_CLEAN") return { clean: true, status: "CLEAN_POS1" };      // swapped now + verified
    if (a304 === "OK") return { clean: true, status: "CLEAN_POS1" };              // already at pos1
    if (a304 === "SWAP_TEXT") return { clean: false, status: "SWAP_TEXT" };
    return { clean: false, status: "STILL_NO_LIFESTYLE" };
  }
  if (swapText.has(id)) return { clean: false, status: "SWAP_TEXT" };
  if (still.has(id)) return { clean: false, status: "STILL_NO_LIFESTYLE" };
  return { clean: false, status: "UNKNOWN" };
}

function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const HEADER = ["shopify_product_id", "handle", "title", "has_clean_lifestyle_pos1", "status"];
const rows = all.map((p) => { const c = classify(p.id); return [p.id, p.handle, p.title, c.clean, c.status]; });
writeFileSync(new URL("../lifestyle-catalog-status-complete.csv", import.meta.url), [HEADER.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n"));

const cleanIds = all.filter((p) => classify(p.id).clean).map((p) => String(p.id));
writeFileSync(new URL("../lifestyle-verified-ids.json", import.meta.url), JSON.stringify(cleanIds, null, 0));
const byStatus = rows.reduce((m, r) => ((m[r[4]] = (m[r[4]] || 0) + 1), m), {});
const cleanCount = rows.filter((r) => r[3] === true).length;
console.log(`Total: ${rows.length}`);
console.log(`has_clean_lifestyle_pos1=true: ${cleanCount}`);
console.log(`by status: ${JSON.stringify(byStatus)}`);
console.log(`Wrote lifestyle-catalog-status-complete.csv + lifestyle-verified-ids.json (${cleanIds.length} ids)`);
