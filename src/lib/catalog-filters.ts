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

/**
 * Turn raw shopper text into a safe FTS5 MATCH expression, or null when it has nothing
 * searchable in it.
 *
 * Two jobs. First, SAFETY: FTS5 MATCH is a query language, and raw input containing `"`,
 * `*`, `:`, `^`, `-`, `NEAR` or `OR` is a syntax error that would throw at query time on a
 * public endpoint. Splitting on non-alphanumerics and re-quoting every token makes operators
 * impossible to inject. Second, RECALL: each token gets a `*` suffix so "canap" still finds
 * "canapé", which mirrors how the LIKE behaved for prefixes.
 *
 * What FTS cannot do that LIKE could: match INSIDE a word. getProducts re-runs the LIKE when
 * an FTS search returns NOTHING, so a purely-infix term still finds its rows.
 *
 * ⚠️ The fallback fires on zero results only, so a term that matches both as a word and as an
 * infix DOES return a smaller set than before. Measured on production (11,896 rows):
 *   sofa 416 = 416 · outdoor 3568 = 3568 · garden 2264 = 2264   (identical)
 *   chair 1922 vs 1957   (LIKE also caught "armchair", "highchair")
 *   table 1609 vs 4656   (LIKE also caught "Adjustable", "Portable", "Foldable")
 * This is a deliberate relevance call: a shopper searching "table" wants tables, not every
 * adjustable desk. To restore exact pre-FTS behaviour, drop `searchMode: "fts"` at the call
 * site — the LIKE path is still here and still correct, just unindexed.
 *
 * Capped at 8 tokens; beyond that the query is noise and the MATCH cost grows.
 */
export function toFtsQuery(raw: string): string | null {
  const tokens = String(raw ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  // Double-quote each token (escaping any embedded quote) so it is a literal string, then
  // append the prefix operator OUTSIDE the quotes — `"canap"*` is valid FTS5 prefix syntax.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export interface CatalogFilterInput {
  productType?: string;
  search?: string;
  /**
   * `"fts"` routes `search` through the indexed products_fts table; anything else keeps the
   * unindexed LIKE. Defaults to LIKE so an unaware caller cannot silently change semantics.
   */
  searchMode?: "like" | "fts";
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
    const fts = f.searchMode === "fts" ? toFtsQuery(f.search) : null;
    if (fts) {
      // Indexed path. `products_fts` is an external-content FTS5 table over (sku, name),
      // so its rowid IS the products rowid — no join needed.
      conditions.push(`rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)`);
      args.push(fts);
    } else {
      // Unindexed fallback: a leading wildcard defeats every B-tree, so this scans all of
      // `products`. Still the default, and still the zero-result fallback in getProducts,
      // so search results can never narrow versus the pre-FTS behaviour.
      conditions.push(`(name LIKE ? OR sku LIKE ?)`);
      args.push(`%${f.search}%`, `%${f.search}%`);
    }
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
    // Use the precomputed flag (recomputeHasDiscount, refreshed each sync) so the filter
    // is a cheap indexed scan and stays consistent with the getCatalogStats count. The
    // canonical PRODUCT_HAS_DISCOUNT_SQL predicate defines the flag's value.
    conditions.push(`has_discount = 1`);
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
