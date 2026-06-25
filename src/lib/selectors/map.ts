/**
 * Shared SQL fragments + row mapping for the content selectors.
 *
 * `compareAtSubquery` derives the pre-discount price the same way
 * catalog-filters.PRODUCT_HAS_DISCOUNT_SQL derives the rabais flag: the most
 * recent price_history change's `old_price`, kept only when it's above the
 * current price. This schema has no compare_at_price column, so this correlated
 * subquery IS the compare-at.
 */
import type { Row } from "@libsql/client";
import type { ProductItem, SelectorOptions } from "./types";
import { discountPct } from "@/lib/slideshow/validate";
import { resolveProductImages } from "./shopify-images";

/**
 * Correlated subquery yielding the derived compare-at price for a product, or
 * NULL when there's no active rabais. `alias` is the products-table alias used
 * in the outer query (default "products").
 */
export function compareAtSubquery(alias = "products"): string {
  return `(
    SELECT lpx.old_price FROM (
      SELECT old_price,
        ROW_NUMBER() OVER (PARTITION BY sku ORDER BY detected_at DESC, id DESC) AS rn
      FROM price_history
      WHERE sku = ${alias}.sku
        AND change_type IN ('price_drop', 'price_increase')
        AND old_price IS NOT NULL
    ) lpx
    WHERE lpx.rn = 1 AND lpx.old_price > ${alias}.price
  )`;
}

/** Base product columns every selector selects (alias-qualified). */
export function productColumns(alias = "products"): string {
  return [
    `${alias}.sku AS sku`,
    `${alias}.name AS name`,
    `${alias}.price AS price`,
    `${alias}.qty AS qty`,
    `${alias}.product_type AS product_type`,
    `${alias}.shopify_handle AS shopify_handle`,
    `${alias}.shopify_product_id AS shopify_product_id`,
    `${compareAtSubquery(alias)} AS compare_at_price`,
  ].join(", ");
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Map a catalog row to a ProductItem (without images — those are resolved
 * asynchronously). `velocity14d` is read when the query supplied it.
 */
export function rowToProductItem(row: Row): ProductItem {
  const o = row as unknown as Record<string, unknown>;
  const price = num(o.price);
  const compareAt = optNum(o.compare_at_price);
  const name = typeof o.name === "string" ? o.name : "";
  return {
    sku: String(o.sku ?? ""),
    title_fr: name,
    title_en: name, // EN lives in Shopify metafields; FR name is the fallback.
    price,
    compare_at_price: compareAt,
    images: [],
    product_type: String(o.product_type ?? ""),
    shopify_handle: String(o.shopify_handle ?? ""),
    shopify_product_id: String(o.shopify_product_id ?? ""),
    velocity14d: optNum(o.velocity14d ?? o.units_moved),
    stock: optNum(o.qty),
    discount_pct: discountPct(price, compareAt),
  };
}

/**
 * Populate `images` on each item with Shopify-CDN URLs unless
 * `opts.resolveImages === false`. Runs through the throttled, cached resolver,
 * so a batch of items costs at most one Shopify request per uncached product.
 */
export async function hydrateImages(items: ProductItem[], opts?: SelectorOptions): Promise<ProductItem[]> {
  if (opts?.resolveImages === false) return items;
  for (const item of items) {
    item.images = item.shopify_product_id ? await resolveProductImages(item.shopify_product_id) : [];
  }
  return items;
}
