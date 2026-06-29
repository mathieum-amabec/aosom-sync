/**
 * By-category — a LOOKBOOK edit of one product_type, sorted four ways.
 *
 *   - velocity:   most units moved in the window first (LEFT JOIN so quiet
 *                 products still appear with velocity 0).
 *   - price_asc:  cheapest first.
 *   - price_desc: priciest first.
 *   - discount:   deepest derived rabais first (no-rabais products sort last).
 *
 * Imported products only.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem, hydrateItems } from "./map";
import type { ProductItem, SelectorOptions } from "./types";

type CategorySort = "velocity" | "price_asc" | "price_desc" | "discount";

const IMPORTED = `products.shopify_product_id IS NOT NULL AND products.shopify_product_id != ''`;

export async function byCategory(
  opts: SelectorOptions & { sort: CategorySort },
): Promise<ProductItem[]> {
  const limit = opts.limit ?? 10;
  const category = opts.category ?? "";
  const windowDays = opts.windowDays ?? 14;
  const key = cacheKey("byCategory", {
    category,
    sort: opts.sort,
    limit,
    windowDays,
    language: opts.language,
    resolveImages: opts.resolveImages,
  });

  return cached(key, async () => {
    const db = await getSelectorDb();
    let sql: string;
    let args: (string | number)[];

    if (opts.sort === "velocity") {
      sql = `
        SELECT ${productColumns("products")},
               COALESCE(SUM(CASE WHEN ph.old_qty > ph.new_qty THEN ph.old_qty - ph.new_qty ELSE 0 END), 0) AS velocity14d
        FROM products
        LEFT JOIN price_history ph
          ON ph.sku = products.sku
          AND ph.change_type = 'stock_change'
          AND ph.detected_at > cast(strftime('%s','now', ?) as integer)
        WHERE products.product_type = ? AND ${IMPORTED}
        GROUP BY products.sku
        ORDER BY velocity14d DESC
        LIMIT ?`;
      args = [`-${windowDays} days`, category, limit];
    } else {
      const order =
        opts.sort === "price_asc"
          ? "price ASC"
          : opts.sort === "price_desc"
            ? "price DESC"
            : "(compare_at_price - price) / price DESC"; // discount
      sql = `
        SELECT * FROM (
          SELECT ${productColumns("products")}
          FROM products
          WHERE products.product_type = ? AND ${IMPORTED}
        )
        ORDER BY ${order}
        LIMIT ?`;
      args = [category, limit];
    }

    const result = await db.execute({ sql, args });
    const items = result.rows.map(rowToProductItem);
    return hydrateItems(items, opts);
  });
}
