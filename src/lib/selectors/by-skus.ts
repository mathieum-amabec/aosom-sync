/**
 * Fetch specific products by SKU — the "manual" selection mode for the
 * generation panel's product preview. Returns normalized ProductItem[] with
 * Shopify-CDN images resolved, in the SAME order the SKUs were requested.
 */
import { cached, cacheKey } from "./cache";
import { getSelectorDb } from "./db";
import { productColumns, rowToProductItem, hydrateImages } from "./map";
import type { ProductItem, SelectorOptions } from "./types";

/** Hard cap so a pasted SKU list can't build an enormous IN clause. */
const MAX_SKUS = 50;

export async function productsBySkus(
  skus: string[],
  opts: SelectorOptions = {},
): Promise<ProductItem[]> {
  const clean = Array.from(
    new Set((skus ?? []).map((s) => String(s).trim()).filter(Boolean)),
  ).slice(0, MAX_SKUS);
  if (clean.length === 0) return [];

  const key = cacheKey("productsBySkus", { skus: clean, resolveImages: opts.resolveImages });

  return cached(key, async () => {
    const db = await getSelectorDb();
    const placeholders = clean.map(() => "?").join(", ");
    const result = await db.execute({
      sql: `SELECT ${productColumns("products")} FROM products WHERE products.sku IN (${placeholders})`,
      args: clean,
    });
    const byKey = new Map<string, ProductItem>();
    for (const r of result.rows) {
      const item = rowToProductItem(r);
      byKey.set(item.sku, item);
    }
    // Preserve the requested order; drop SKUs that don't exist.
    const items = clean.map((sku) => byKey.get(sku)).filter((x): x is ProductItem => Boolean(x));
    return hydrateImages(items, opts);
  });
}
