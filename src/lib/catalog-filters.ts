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
 * impossible to inject. Second, RECALL: the last token gets a `*` suffix so "canap" still
 * finds "canapé", which mirrors how the LIKE behaved for prefixes.
 *
 * PHRASE, not independent AND (dashboard bug, 2026-09-17 — Mat's "bed frame" report). Every
 * token used to be quoted+`*` SEPARATELY (`"bed"* "frame"*`), which FTS5 reads as an implicit
 * AND of two unrelated prefix terms — matching ANY row containing both words ANYWHERE, in any
 * order. Measured on production: searching "bed frame" returned 100 rows for 12 real bed
 * frames — 88 were noise (raised garden BEDs, mirrors with a metal FRAME, a hammock FRAME with
 * a day BED), because "Bed" and "Frame" appear separately all over the catalog. The 12 real
 * matches were never missing from the DB or the result set — they were buried in it, which is
 * indistinguishable from "missing" to someone scanning a few rows.
 *
 * The fix quotes the WHOLE token sequence as one FTS5 phrase with the prefix operator applied
 * to the phrase (`"bed frame"*`), so a match now requires "bed" immediately followed by a word
 * starting with "frame" — exactly what "Bed Frame"/"Bed Frames" is, in both the product name
 * AND the taxonomy path (buildCatalogWhere's FTS index also covers `product_type`, whose
 * separators tokenize the same way, e.g. "…Bedroom Furniture > Bed Frames" → "Bed" "Frames"
 * adjacent). A single-token search is unaffected (`"canap"*` behaves exactly as before).
 *
 * What FTS cannot do that LIKE could: match INSIDE a word. getProducts re-runs the LIKE when
 * an FTS search returns NOTHING, so a purely-infix term still finds its rows.
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
  // One quoted phrase (escaping any embedded quote), prefix operator OUTSIDE the quotes —
  // `"bed frame"*` is valid FTS5 phrase-prefix syntax: adjacency for every token, prefix
  // match on the last one.
  const phrase = tokens.map((t) => t.replace(/"/g, '""')).join(" ");
  return `"${phrase}"*`;
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
      // Indexed path. `products_fts` is an external-content FTS5 table over
      // (sku, name, product_type), so its rowid IS the products rowid — no join needed.
      // product_type carries the full Aosom taxonomy path ("Home Furnishings > Bedroom
      // Furniture > Bed Frames"), so a search term that only matches the category — not
      // the product's own name — still finds it (2026-09-17 catalog-search-bedframe-gap fix).
      conditions.push(`rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)`);
      args.push(fts);
    } else {
      // Unindexed fallback: a leading wildcard defeats every B-tree, so this scans all of
      // `products`. Still the default, and still the zero-result fallback in getProducts,
      // so search results can never narrow versus the pre-FTS behaviour. Includes
      // product_type for the same category-search reason as the FTS path above.
      conditions.push(`(name LIKE ? OR sku LIKE ? OR product_type LIKE ?)`);
      args.push(`%${f.search}%`, `%${f.search}%`, `%${f.search}%`);
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

/**
 * Derive the "sous-catégorie" dropdown options for the dashboard catalog page, from the
 * SAME `productTypes` list the top-level "All categories" select already uses (getProducts'
 * `product_type_counts`-backed field — see database.ts `rebuildProductTypeCounts`, which
 * already stores every prefix level of the Aosom taxonomy path, e.g. for
 * "Home Furnishings > Bedroom Furniture > Bed Frames" it stores counts for all three of
 * "Home Furnishings", "Home Furnishings > Bedroom Furniture", and the full string). No new
 * data source needed — subcategories were already computed and returned by the API; the
 * catalog page just filtered them out (`!t.type.includes(">")`) when building the top-level
 * select. This reuses that same source of truth for the *next* level down.
 *
 * `selectedCategory` is the chosen top-level category (empty = no subcategories to offer —
 * a subcategory is meaningless without a parent). Returns only entries exactly ONE level
 * deeper than `selectedCategory`, so the dropdown stays a flat, manageable list even where
 * the Aosom taxonomy nests 3-4 levels deep (e.g. "Patio & Garden > Lawn & Garden > Raised
 * Garden Beds > Elevated Garden Beds").
 */
export function deriveSubCategoryOptions(
  productTypes: { type: string; count: number }[],
  selectedCategory: string
): { type: string; count: number }[] {
  if (!selectedCategory) return [];
  const parentDepth = selectedCategory.split(">").length;
  const prefix = `${selectedCategory} > `;
  return productTypes.filter(
    (t) => t.type.startsWith(prefix) && t.type.split(">").length === parentDepth + 1
  );
}
