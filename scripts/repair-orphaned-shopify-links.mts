// One-off repair for the 2026-09-30 investigation: products.shopify_product_id is written
// exactly once, best-effort, right after a successful Shopify import (linkProductToShopify in
// import-pipeline.ts) — a swallowed failure there leaves the row NULL forever, invisible to
// the stale-catalog (30-day) and stock-check safety nets. 193 products were affected,
// continuously, from April through September. The daily stale-catalog cron now reconciles
// this itself (see reconcileProductShopifyLinks in src/lib/database.ts) — this script is the
// one-time catch-up for everything that accumulated before that fix shipped.
//
// Uses Shopify's OWN current variant list as the source of truth (a SKU normally lives on
// exactly one Shopify product at a time), so it also self-heals the rarer case of a SKU
// pointing at a product that was deleted and re-created since. Never writes to Shopify —
// Turso only.
//
// DRY RUN by default. --apply writes.
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/repair-orphaned-shopify-links.mts [--apply]
import * as shopifyNs from "../src/lib/shopify-client";
import * as dbNs from "../src/lib/database";

// tsx may surface a CommonJS module's named exports under `default`.
type ShopifyLib = typeof import("../src/lib/shopify-client");
type Db = typeof import("../src/lib/database");
const shopify: ShopifyLib = (shopifyNs as unknown as { default?: ShopifyLib }).default ?? (shopifyNs as unknown as ShopifyLib);
const db: Db = (dbNs as unknown as { default?: Db }).default ?? (dbNs as unknown as Db);

const APPLY = process.argv.includes("--apply");

console.log("fetching every Shopify product (paginated)...");
const live = await shopify.fetchAllShopifyProducts();
const input = live.map((p) => ({ shopifyId: p.shopifyId, handle: p.handle || null, skus: p.variants.map((v) => v.sku).filter(Boolean) }));
console.log(`${live.length} Shopify products, ${input.reduce((n, p) => n + p.skus.length, 0)} variant SKUs`);

if (!APPLY) {
  // Dry-run preview: re-derive exactly what reconcileProductShopifyLinks would change,
  // without calling it (it writes unconditionally once invoked).
  const allSkus = input.flatMap((p) => p.skus);
  const current = new Map<string, string | null>();
  for (let i = 0; i < allSkus.length; i += 500) {
    const chunk = allSkus.slice(i, i + 500);
    const r = await db.getFeedRowsForSkus(chunk);
    for (const row of r) current.set(row.sku, row.shopifyProductId);
  }
  let missing = 0, wrong = 0;
  const examples: string[] = [];
  for (const p of input) {
    for (const sku of p.skus) {
      if (!current.has(sku)) continue;
      const cur = current.get(sku);
      if (cur === p.shopifyId) continue;
      if (cur === null) missing++; else wrong++;
      if (examples.length < 15) examples.push(`${sku}: ${cur ?? "NULL"} -> ${p.shopifyId}`);
    }
  }
  console.log(`would fix: ${missing} missing links, ${wrong} pointing at a different product`);
  for (const e of examples) console.log(" ", e);
  console.log("DRY RUN — nothing written. --apply to write.");
  process.exit(0);
}

const fixed = await db.reconcileProductShopifyLinks(input);
console.log(`applied: ${fixed} SKUs corrected`);
