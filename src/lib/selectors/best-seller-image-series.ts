/**
 * Single-product image series for a SHOWCASE slideshow.
 *
 * Returns one product hydrated with ALL of its Shopify-CDN images (not just the
 * first), so the renderer can build a multi-angle hero montage from one SKU.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem } from "./map";
import { resolveProductImages } from "./shopify-images";
import type { ProductItem } from "./types";

export async function bestSellerImageSeries(
  sku: string,
): Promise<(ProductItem & { allImages: string[] }) | null> {
  const key = cacheKey("bestSellerImageSeries", { sku });

  return cached(key, async () => {
    const db = await getSelectorDb();
    const result = await db.execute({
      sql: `SELECT ${productColumns("products")} FROM products WHERE products.sku = ? LIMIT 1`,
      args: [sku],
    });
    if (result.rows.length === 0) return null;

    const item = rowToProductItem(result.rows[0]);
    const allImages = item.shopify_product_id
      ? await resolveProductImages(item.shopify_product_id)
      : [];
    item.images = allImages;
    return { ...item, allImages };
  });
}
