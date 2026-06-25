/**
 * Wow / discovery — surfaces products for the DISCOVERY template via one of
 * three strategies:
 *   - margin: deepest rabais (derived compare_at >= price * 1.15), best first.
 *   - new:    imported within the last `windowDays` (default 30), newest first.
 *   - random: a random imported product sampling.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem, hydrateImages } from "./map";
import type { ProductItem, SelectorOptions } from "./types";

type WowStrategy = "margin" | "new" | "random";

const IMPORTED = `products.shopify_product_id IS NOT NULL AND products.shopify_product_id != ''`;

export async function wowDiscovery(
  opts: SelectorOptions & { strategy: WowStrategy },
): Promise<ProductItem[]> {
  const limit = opts.limit ?? 10;
  const windowDays = opts.windowDays ?? 30;
  const key = cacheKey("wowDiscovery", {
    strategy: opts.strategy,
    limit,
    windowDays,
    resolveImages: opts.resolveImages,
  });

  return cached(key, async () => {
    const db = await getSelectorDb();
    let sql: string;
    let args: (string | number)[];

    if (opts.strategy === "margin") {
      // 15%+ rabais, deepest relative discount first.
      sql = `
        SELECT * FROM (
          SELECT ${productColumns("products")} FROM products WHERE ${IMPORTED}
        )
        WHERE compare_at_price IS NOT NULL AND compare_at_price >= price * 1.15
        ORDER BY (compare_at_price - price) / price DESC
        LIMIT ?`;
      args = [limit];
    } else if (opts.strategy === "new") {
      sql = `
        SELECT ${productColumns("products")} FROM products
        WHERE ${IMPORTED}
          AND products.created_at > cast(strftime('%s','now', ?) as integer)
        ORDER BY products.created_at DESC
        LIMIT ?`;
      args = [`-${windowDays} days`, limit];
    } else {
      sql = `
        SELECT ${productColumns("products")} FROM products
        WHERE ${IMPORTED}
        ORDER BY RANDOM()
        LIMIT ?`;
      args = [limit];
    }

    const result = await db.execute({ sql, args });
    const items = result.rows.map(rowToProductItem);
    return hydrateImages(items, opts);
  });
}
