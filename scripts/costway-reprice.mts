#!/usr/bin/env tsx
/**
 * scripts/costway-reprice.mts — put every Costway product already on Shopify at the current price rule (pricing.ts:
 * 23 % target margin, x.99 endings, never below Costway's price or Price Drop), so the catalogue's prices stay uniform.
 *
 *   node-x64 --env-file=<main clone>/.env.local node_modules/tsx/dist/cli.mjs scripts/costway-reprice.mts           # dry run
 *   node-x64 --env-file=… node_modules/tsx/dist/cli.mjs scripts/costway-reprice.mts --apply                          # writes
 *
 * Only the selling price changes: the crossed-out price is never touched (updateShopifyVariantPrice without oldPrice).
 * Variants are matched by our internal SKU. ≤ 2 Shopify calls per second.
 */
const APPLY = process.argv.includes("--apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ensureSchema } = await import("@/lib/database");
  const { costwaySellPrice, marginOf } = await import("@/lib/costway/pricing");
  const sc = await import("@/lib/shopify-client");
  const db = await ensureSchema();
  const rows = (
    await db.execute(
      `SELECT sku, internal_sku, shopify_product_id, price, price_drop, promo_tag, sell_price FROM costway_products
        WHERE shopify_product_id IS NOT NULL AND shopify_product_id != '' AND internal_sku IS NOT NULL AND removed_at IS NULL`,
    )
  ).rows;
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${rows.length} Costway variant(s) on Shopify`);

  const byProduct = new Map<string, typeof rows>();
  for (const r of rows) byProduct.set(String(r.shopify_product_id), [...(byProduct.get(String(r.shopify_product_id)) ?? []), r]);

  let changed = 0, same = 0, missing = 0;
  for (const [productId, group] of byProduct) {
    const res = await sc.shopifyFetch(`/products/${productId}.json?fields=id,variants`);
    await sleep(550);
    if (!res.ok) { console.log(`✗ product ${productId}: HTTP ${res.status}`); missing += group.length; continue; }
    const variants = ((await res.json()).product?.variants ?? []) as Array<{ id: number; sku: string; price: string }>;
    for (const r of group) {
      const v = variants.find((x) => x.sku === String(r.internal_sku));
      if (!v) { console.log(`✗ ${r.internal_sku}: variant not found on ${productId}`); missing++; continue; }
      const next = costwaySellPrice({ price: Number(r.price), priceDrop: r.price_drop == null ? null : Number(r.price_drop), promoTag: String(r.promo_tag ?? "") });
      const now = Number(v.price);
      if (!Number.isFinite(next)) { console.log(`✗ ${r.internal_sku}: unusable feed price ${r.price}`); missing++; continue; }
      if (Math.abs(next - now) < 0.005) { same++; continue; }
      const m = marginOf(next, Number(r.price));
      console.log(`${r.internal_sku}  ${now.toFixed(2)} → ${next.toFixed(2)} $  (Costway ${Number(r.price).toFixed(2)}, marge ${m.pct} %)`);
      changed++;
      if (APPLY) {
        await sc.updateShopifyVariantPrice(String(v.id), next);
        await db.execute({ sql: `UPDATE costway_products SET sell_price = ? WHERE sku = ?`, args: [next, r.sku] });
        await sleep(550);
      }
    }
  }
  console.log(`\n${changed} ${APPLY ? "updated" : "to update"}, ${same} already right, ${missing} skipped`);
}

main().catch((e) => { console.error(e); process.exit(1); });
