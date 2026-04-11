import { NextResponse } from "next/server";
import { getProductsWithShopifyId, findCollectionForProduct } from "@/lib/database";
import { addProductToCollection, getProductCollections } from "@/lib/shopify-client";

/**
 * POST /api/collections/sync — Sync existing Shopify products into their mapped collections.
 * Processes in batches, respects rate limits.
 */
export async function POST() {
  try {
    const products = await getProductsWithShopifyId();
    let added = 0;
    let skipped = 0;
    let noMapping = 0;
    let errors = 0;
    const errorList: { sku: string; error: string }[] = [];

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      const mapping = await findCollectionForProduct(p.product_type);
      if (!mapping) {
        noMapping++;
        continue;
      }

      try {
        // Check if already in the collection
        const existing = await getProductCollections(p.shopify_product_id);
        if (existing.includes(mapping.shopifyCollectionId)) {
          skipped++;
          continue;
        }

        await addProductToCollection(p.shopify_product_id, mapping.shopifyCollectionId);
        added++;

        // Rate limit: ~2 req/sec (we did 2 calls above: getProductCollections + addProductToCollection)
        if (i % 5 === 4) {
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (err) {
        errors++;
        errorList.push({ sku: p.sku, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return NextResponse.json({
      success: true,
      data: { total: products.length, added, skipped, noMapping, errors, errorList: errorList.slice(0, 20) },
    });
  } catch (err) {
    console.error("[API] /api/collections/sync failed:", err);
    return NextResponse.json({ success: false, error: "Collection sync failed" }, { status: 500 });
  }
}

export const maxDuration = 300;
