/**
 * Low stock — scarcity push for the URGENCY template.
 *
 * Returns imported products with qty > 0 AND qty <= threshold (default 5),
 * scarcest first.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem, hydrateImages } from "./map";
import type { ProductItem, SelectorOptions } from "./types";

export async function lowStock(
  opts: SelectorOptions & { threshold?: number } = {},
): Promise<ProductItem[]> {
  const limit = opts.limit ?? 10;
  const threshold = opts.threshold ?? 5;
  const key = cacheKey("lowStock", { limit, threshold, resolveImages: opts.resolveImages });

  return cached(key, async () => {
    const db = await getSelectorDb();
    const result = await db.execute({
      sql: `
        SELECT ${productColumns("products")}
        FROM products
        WHERE products.qty > 0
          AND products.qty <= ?
          AND products.shopify_product_id IS NOT NULL
          AND products.shopify_product_id != ''
        ORDER BY products.qty ASC
        LIMIT ?`,
      args: [threshold, limit],
    });
    const items = result.rows.map(rowToProductItem);
    return hydrateImages(items, opts);
  });
}
