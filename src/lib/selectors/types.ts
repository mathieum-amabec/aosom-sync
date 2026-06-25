/**
 * Shared types for the content selectors (Module B).
 *
 * Selectors read the catalog (Turso) and return a normalized ProductItem the
 * slideshow engine can consume directly. Two schema realities shape this type:
 *
 *  - There is NO `compare_at_price` column. `compare_at_price` here is DERIVED
 *    from the most recent price_history drop (the same model as
 *    catalog-filters.PRODUCT_HAS_DISCOUNT_SQL), and is undefined when the
 *    product has no active rabais.
 *  - Catalog images (products.image1..7) are Aosom-CDN URLs, which our render
 *    workers can't fetch. `images` therefore holds only Shopify-CDN URLs,
 *    resolved from the live product via the Shopify API (see shopify-images.ts).
 *    A product with no resolvable Shopify images gets `images: []`.
 */

export interface ProductItem {
  sku: string;
  /** French product title (products.name). */
  title_fr: string;
  /**
   * English title. This schema keeps EN copy in Shopify metafields, not the
   * catalog DB, so selectors fall back to the FR name. Downstream modules that
   * need true EN can hydrate from the metafield.
   */
  title_en: string;
  price: number;
  /** Derived pre-discount price, or undefined when there is no active rabais. */
  compare_at_price?: number;
  /** Shopify-CDN image URLs only (never Aosom CDN). May be empty. */
  images: string[];
  product_type: string;
  shopify_handle: string;
  shopify_product_id: string;
  /** Units moved over the velocity window (best-sellers only). */
  velocity14d?: number;
  /** Current stock (products.qty). */
  stock?: number;
  /** Rounded discount percentage when compare_at_price applies. */
  discount_pct?: number;
}

export interface SelectorOptions {
  /** Max rows to return. Defaults are per-selector (typically 10). */
  limit?: number;
  /** Overlay/title language hint passed through to consumers. Default 'fr'. */
  language?: "fr" | "en";
  /** product_type filter (exact match unless the selector says otherwise). */
  category?: string;
  /** Velocity / recency window in days (default 14 for best-sellers). */
  windowDays?: number;
  /**
   * Resolve Shopify-CDN images for each returned product (default true).
   * Set false to skip the per-product Shopify round-trips when only metadata /
   * ranking is needed — returned items then carry `images: []`.
   */
  resolveImages?: boolean;
}
