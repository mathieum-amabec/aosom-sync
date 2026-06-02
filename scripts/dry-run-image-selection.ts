#!/usr/bin/env tsx
/**
 * scripts/dry-run-image-selection.ts
 *
 * DRY-RUN for feature/image-selection (Étape 1). Reads a local copy of the
 * Aosom feed, reconstructs each product's image union (same as collectImages +
 * PSIN grouping), and runs the REAL selectProductImages() from the lib so the
 * output reflects exactly what import would store. Writes nothing to Shopify.
 *
 * Usage: FEED=/path/to/feed.csv tsx scripts/dry-run-image-selection.ts
 */
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import {
  parseSku,
  selectProductImages,
  smallestUrlDimension,
  MIN_IMAGE_PX,
  MAX_IMAGES_PER_PRODUCT,
} from "@/lib/variant-merger";

const FEED = process.env.FEED;
if (!FEED) {
  console.error("Set FEED=/path/to/aosom_feed.csv");
  process.exit(1);
}

type Row = Record<string, string>;
const text = readFileSync(FEED, "utf8");
const delimiter = text.split("\n")[0].includes("\t") ? "\t" : ",";
const rows: Row[] = (parse(text, {
  columns: true,
  delimiter,
  skip_empty_lines: true,
  relax_column_count: true,
  trim: true,
}) as Row[]).filter((r) => r.SKU != null && r.SKU.trim() !== "");

// Mirror csv-fetcher.collectImages
function collectImages(row: Row): string[] {
  const urls: string[] = [];
  if (row.Image?.trim()) urls.push(row.Image.trim());
  if (row.Images?.trim()) {
    const sep = row.Images.includes("|") ? "|" : ",";
    for (const u of row.Images.split(sep)) {
      const t = u.trim();
      if (t && !urls.includes(t)) urls.push(t);
    }
  }
  for (let i = 1; i <= 7; i++) {
    const v = row[`Image${i}`]?.trim();
    if (v && !urls.includes(v)) urls.push(v);
  }
  return urls;
}
function groupKey(row: Row): string {
  if (row.Psin && row.Psin.trim() !== "") return row.Psin.trim();
  return parseSku(row.SKU.trim()).base;
}

// Group rows → product, union images (mirrors mergeVariants image union)
type Product = { key: string; name: string; type: string; images: string[]; variants: number };
const groups = new Map<string, Product>();
for (const row of rows) {
  const key = groupKey(row);
  const g = groups.get(key);
  const imgs = collectImages(row);
  if (g) {
    g.variants++;
    for (const im of imgs) if (!g.images.includes(im)) g.images.push(im);
  } else {
    groups.set(key, { key, name: row.Name || "", type: row.Product_Type || "", images: imgs, variants: 1 });
  }
}
const products = [...groups.values()];

// ── Catalog-wide false-positive audit ───────────────────────────────────
const allUrls = new Set<string>();
for (const p of products) for (const u of p.images) allUrls.add(u);
let droppedBySize = 0;
const dropExamples: string[] = [];
for (const u of allUrls) {
  const dim = smallestUrlDimension(u);
  if (dim !== null && dim < MIN_IMAGE_PX) {
    droppedBySize++;
    if (dropExamples.length < 8) dropExamples.push(`${dim}px  ${u}`);
  }
}
const withLifestyle = [...allUrls].filter((u) => /lifestyle|ambiance|room/i.test(u)).length;

console.log("══════════════════════════════════════════════════════════════════");
console.log(" DRY-RUN — image selection (Étape 1)   NO Shopify writes");
console.log("══════════════════════════════════════════════════════════════════");
console.log(`Feed: ${FEED}`);
console.log(`Products (grouped): ${products.length}   Distinct image URLs: ${allUrls.size}`);
console.log(`Rules: drop size < ${MIN_IMAGE_PX}px (URL-detectable only) · max ${MAX_IMAGES_PER_PRODUCT} · lifestyle→pos.1`);
console.log("");
console.log("── Catalog-wide audit ─────────────────────────────────────────────");
console.log(`Images dropped by size filter: ${droppedBySize} / ${allUrls.size}`);
dropExamples.forEach((e) => console.log("   drop: " + e));
console.log(`Images matching lifestyle|ambiance|room: ${withLifestyle}`);
const overCap = products.filter((p) => p.images.length > MAX_IMAGES_PER_PRODUCT).length;
console.log(`Products over the ${MAX_IMAGES_PER_PRODUCT}-image cap (capped today): ${overCap} / ${products.length}`);
console.log("");

// ── Pick 10 VARIED products: spread across image-count distribution + distinct types ──
const sorted = [...products].sort((a, b) => b.images.length - a.images.length);
const picks: Product[] = [];
const seenTypes = new Set<string>();
const wantIdx = [0, 1, Math.floor(sorted.length * 0.05), Math.floor(sorted.length * 0.15),
  Math.floor(sorted.length * 0.3), Math.floor(sorted.length * 0.45), Math.floor(sorted.length * 0.6),
  Math.floor(sorted.length * 0.75), Math.floor(sorted.length * 0.9), sorted.length - 1];
for (const i of wantIdx) {
  // walk forward to a product with a not-yet-seen type when possible
  let j = i;
  while (j < sorted.length && seenTypes.has(sorted[j].type) && j - i < 50) j++;
  const p = sorted[Math.min(j, sorted.length - 1)];
  if (!picks.includes(p)) { picks.push(p); seenTypes.add(p.type); }
}

console.log("── 10 sample products: BEFORE → AFTER ─────────────────────────────");
picks.forEach((p, n) => {
  const after = selectProductImages(p.images);
  console.log(`\n[${n + 1}] ${p.name.slice(0, 70)}`);
  console.log(`    type=${p.type || "?"} · variants=${p.variants}`);
  console.log(`    BEFORE: ${p.images.length} images`);
  p.images.slice(0, 12).forEach((u, i) => console.log(`       ${i + 1}. ${u}`));
  if (p.images.length > 12) console.log(`       … +${p.images.length - 12} more`);
  console.log(`    AFTER:  ${after.length} images (cap ${MAX_IMAGES_PER_PRODUCT})`);
  console.log(`    position 1 → ${after[0] ?? "(none)"}`);
  const changed = after.length !== p.images.length || after[0] !== p.images[0];
  console.log(`    change: ${changed ? "yes" : "no (only cap/identity)"}`);
});
console.log("\n══════════════════════════════════════════════════════════════════");
