/**
 * Price drops — products with an active rabais of at least `minPct` (default 10%).
 *
 * "compare at" is derived from the latest price_history drop (see map.ts); this
 * schema has no compare_at_price column. Ordered by deepest relative discount.
 * Imported products only.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem, hydrateImages } from "./map";
import type { ProductItem, SelectorOptions } from "./types";

export async function priceDrops(
  opts: SelectorOptions & { minPct?: number } = {},
): Promise<ProductItem[]> {
  const limit = opts.limit ?? 10;
  const minPct = opts.minPct ?? 10;
  const ratio = 1 + minPct / 100;
  const key = cacheKey("priceDrops", { limit, minPct, resolveImages: opts.resolveImages });

  return cached(key, async () => {
    const db = await getSelectorDb();
    const result = await db.execute({
      sql: `
        SELECT * FROM (
          SELECT ${productColumns("products")}
          FROM products
          WHERE products.shopify_product_id IS NOT NULL
            AND products.shopify_product_id != ''
        )
        WHERE compare_at_price IS NOT NULL
          AND compare_at_price >= price * ?
        ORDER BY (compare_at_price - price) / price DESC
        LIMIT ?`,
      args: [ratio, limit],
    });
    const items = result.rows.map(rowToProductItem);
    return hydrateImages(items, opts);
  });
}
