/**
 * Price history per Shopify-linked product, shared by the compare-at sync and the sell-price sync. Lives apart from
 * compare-at-db.ts so the sell-price code does not import the Shopify client (which itself imports the sell-price code).
 */
import { ensureSchema } from "@/lib/database";
import type { PriceSource, PriceStep } from "@/lib/compare-at";

/** Price steps and first-seen date for every product linked to Shopify. */
export async function loadCompareAtSources(): Promise<Map<string, PriceSource>> {
  const db = await ensureSchema();
  const prods = await db.execute(
    `SELECT sku, price, created_at FROM products WHERE price > 0 AND shopify_product_id IS NOT NULL AND shopify_product_id != ''`,
  );
  const hist = await db.execute(
    `SELECT sku, old_price, new_price, detected_at FROM price_history
     WHERE old_price IS NOT NULL AND new_price IS NOT NULL AND old_price != new_price
     ORDER BY sku, detected_at`,
  );
  const steps = new Map<string, PriceStep[]>();
  for (const h of hist.rows) {
    const sku = String(h.sku);
    const list = steps.get(sku) ?? [];
    list.push({ oldPrice: Number(h.old_price), newPrice: Number(h.new_price), at: Number(h.detected_at) });
    steps.set(sku, list);
  }
  const out = new Map<string, PriceSource>();
  for (const p of prods.rows) {
    const sku = String(p.sku);
    const created = Number(p.created_at);
    out.set(sku, { dbPrice: Number(p.price), steps: steps.get(sku) ?? [], firstSeenAt: Number.isFinite(created) && created > 0 ? created : null });
  }
  return out;
}
