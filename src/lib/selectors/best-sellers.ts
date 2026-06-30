/**
 * Best sellers — top movers by stock depletion over a rolling window.
 *
 * Velocity = SUM(old_qty - new_qty) across `stock_change` price_history rows in
 * the window where stock went DOWN (old_qty > new_qty), the same signal
 * getTrendingProducts uses. Only imported products (live on Shopify) qualify,
 * since a slideshow needs Shopify-CDN imagery.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem, hydrateItems } from "./map";
import type { ProductItem, SelectorOptions } from "./types";

export async function bestSellers(opts: SelectorOptions = {}): Promise<ProductItem[]> {
  const limit = opts.limit ?? 10;
  const windowDays = opts.windowDays ?? 14;
  const key = cacheKey("bestSellers", { limit, windowDays, language: opts.language, resolveImages: opts.resolveImages });

  return cached(key, async () => {
    const db = await getSelectorDb();
    const result = await db.execute({
      sql: `
        SELECT ${productColumns("products")},
               SUM(ph.old_qty - ph.new_qty) AS velocity14d
        FROM price_history ph
        JOIN products ON products.sku = ph.sku
        WHERE ph.change_type = 'stock_change'
          AND ph.detected_at > cast(strftime('%s','now', ?) as integer)
          AND ph.old_qty > ph.new_qty
          AND products.shopify_product_id IS NOT NULL
          AND products.shopify_product_id != ''
        GROUP BY products.sku
        ORDER BY velocity14d DESC
        LIMIT ?`,
      args: [`-${windowDays} days`, limit],
    });
    const items = result.rows.map(rowToProductItem);
    return hydrateItems(items, opts);
  });
}
