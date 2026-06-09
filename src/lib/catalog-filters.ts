/**
 * Catalog WHERE-clause builder, shared by getProducts (the listing) and
 * getCatalogStats (the header counts).
 *
 * Deliberately DB-free (no libsql import) so the filter logic can be unit-tested
 * in isolation. Every condition references the `products` table by name (no
 * alias), so the same fragments work in `FROM products WHERE …`, inside the
 * `filtered AS (SELECT … FROM products WHERE …)` CTE, and in the stat counts.
 */

/** "Stock faible" threshold — a product with qty below this is low stock. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * "Avec rabais" predicate. This schema has no `compare_at_price` column; the
 * discount signal is the most recent price-change's old_price being above the
 * current price — the same value the catalog renders as the ▼ badge (the
 * `last_price` CTE in getProducts). Correlated on `products.sku` / `products.price`
 * so it can drop straight into a WHERE clause.
 */
export const PRODUCT_HAS_DISCOUNT_SQL = `EXISTS (
  SELECT 1 FROM (
    SELECT old_price,
      ROW_NUMBER() OVER (PARTITION BY sku ORDER BY detected_at DESC, id DESC) AS rn
    FROM price_history
    WHERE sku = products.sku
      AND change_type IN ('price_drop', 'price_increase')
      AND old_price IS NOT NULL
  ) lpx
  WHERE lpx.rn = 1 AND lpx.old_price > products.price
)`;

export interface CatalogFilterInput {
  productType?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  color?: string;
  size?: string;
  /** Only products not yet imported into Shopify (shopify_product_id empty). */
  notImported?: boolean;
  /** Only products whose current price is below their last price (active rabais). */
  withDiscount?: boolean;
  /** Only products with qty < LOW_STOCK_THRESHOLD. */
  lowStock?: boolean;
}

export interface CatalogWhere {
  /** "WHERE …" (or "" when no filters). */
  where: string;
  conditions: string[];
  args: (string | number)[];
}

/**
 * Build the catalog WHERE clause + positional args. `conditions` and `args` are
 * kept in lockstep so the `?` placeholders line up regardless of which filters
 * are active.
 */
export function buildCatalogWhere(f: CatalogFilterInput): CatalogWhere {
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (f.productType) {
    conditions.push(`product_type LIKE ?`);
    args.push(`${f.productType}%`);
  }
  if (f.search) {
    conditions.push(`(name LIKE ? OR sku LIKE ?)`);
    args.push(`%${f.search}%`, `%${f.search}%`);
  }
  if (f.minPrice !== undefined) {
    conditions.push(`price >= ?`);
    args.push(f.minPrice);
  }
  if (f.maxPrice !== undefined) {
    conditions.push(`price <= ?`);
    args.push(f.maxPrice);
  }
  if (f.inStock) {
    conditions.push(`qty > 0`);
  }
  if (f.color) {
    conditions.push(`color = ?`);
    args.push(f.color);
  }
  if (f.size) {
    conditions.push(`size = ?`);
    args.push(f.size);
  }
  if (f.notImported) {
    conditions.push(`(shopify_product_id IS NULL OR shopify_product_id = '')`);
  }
  if (f.lowStock) {
    conditions.push(`qty < ?`);
    args.push(LOW_STOCK_THRESHOLD);
  }
  if (f.withDiscount) {
    conditions.push(PRODUCT_HAS_DISCOUNT_SQL);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    conditions,
    args,
  };
}

/** Parse a query-string flag ("true"/"1" → true). Handy for route handlers. */
export function parseBoolParam(value: string | null): boolean {
  return value === "true" || value === "1";
}
