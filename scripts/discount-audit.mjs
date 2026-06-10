// B1 — Discount credibility audit. READ-ONLY (no product writes).
// For each product whose best discounted variant has compare_at_price > price,
// compute the discount % and bucket it. Output docs/discount-audit.csv + summary.
// Buckets (store rule: >=10% to show a strikethrough price):
//   <10%   -> "remove"  (not credible — should drop compare_at)
//   10-40% -> "ok"
//   >40%   -> "review"  (defensible? manual review)
import { writeFileSync } from "node:fs";
import { gql, sleep } from "./_shopify-lib.mjs";

const QUERY = `query($cursor: String) {
  products(first: 250, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId
      title
      variants(first: 100) { nodes { price compareAtPrice } }
    }
  }
}`;

const rows = [];
let cursor = null, page = 0, scanned = 0;
do {
  const data = await gql(QUERY, { cursor });
  const conn = data.data.products;
  for (const p of conn.nodes) {
    scanned++;
    // Pick the variant with the largest credible discount (the headline strikethrough).
    let best = null;
    for (const v of p.variants.nodes) {
      const price = parseFloat(v.price);
      const cap = v.compareAtPrice == null ? null : parseFloat(v.compareAtPrice);
      if (cap != null && cap > price && price > 0) {
        const pct = ((cap - price) / cap) * 100;
        if (!best || pct > best.pct) best = { price, cap, pct };
      }
    }
    if (best) {
      const bucket = best.pct < 10 ? "remove" : best.pct <= 40 ? "ok" : "review";
      rows.push({
        product_id: p.legacyResourceId,
        title: p.title,
        price: best.price.toFixed(2),
        compare_at_price: best.cap.toFixed(2),
        discount_pct: best.pct.toFixed(1),
        bucket,
      });
    }
  }
  cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  page++;
  if (cursor) await sleep(500); // ~2 req/sec
} while (cursor);

// --- CSV (UTF-8 BOM, quoted) ---
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const header = ["product_id", "title", "price", "compare_at_price", "discount_pct", "bucket"];
const lines = [header.join(",")];
for (const r of rows) lines.push(header.map((h) => esc(r[h])).join(","));
writeFileSync("docs/discount-audit.csv", "﻿" + lines.join("\r\n") + "\r\n", "utf8");

// --- Summary ---
const by = (b) => rows.filter((r) => r.bucket === b);
const remove = by("remove"), ok = by("ok"), review = by("review");
console.log(`Scanned products: ${scanned} (GraphQL pages: ${page})`);
console.log(`On-sale products (compare_at > price): ${rows.length}`);
console.log(`  <10%  remove : ${remove.length}`);
console.log(`  10-40% ok    : ${ok.length}`);
console.log(`  >40%  review : ${review.length}`);

const fmt = (r) => `  ${r.discount_pct}% | $${r.price} <- $${r.compare_at_price} | ${r.product_id} | ${r.title.slice(0, 50)}`;
console.log(`\n=== 15 most suspect (>40%, highest first) ===`);
review.sort((a, b) => parseFloat(b.discount_pct) - parseFloat(a.discount_pct)).slice(0, 15).forEach((r) => console.log(fmt(r)));
console.log(`\n=== 15 not-credible (<10%, lowest first) ===`);
remove.sort((a, b) => parseFloat(a.discount_pct) - parseFloat(b.discount_pct)).slice(0, 15).forEach((r) => console.log(fmt(r)));

console.log("\nWrote docs/discount-audit.csv (" + rows.length + " rows). NO product writes performed.");
