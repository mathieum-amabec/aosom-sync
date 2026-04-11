import { NextResponse } from "next/server";
import { getProductsWithShopifyId, getAllCollectionMappings } from "@/lib/database";
import type { CollectionMapping } from "@/lib/database";
import { addProductToCollection, getProductCollections } from "@/lib/shopify-client";

/** Match a product type against the mapping table in-memory (walk up hierarchy). */
function findMappingForType(productType: string, mappingMap: Map<string, CollectionMapping>): CollectionMapping | null {
  const exact = mappingMap.get(productType);
  if (exact) return exact;
  const parts = productType.split(">").map(s => s.trim());
  for (let i = parts.length - 1; i >= 1; i--) {
    const parent = parts.slice(0, i).join(" > ");
    const match = mappingMap.get(parent);
    if (match) return match;
  }
  return null;
}

/**
 * POST /api/collections/sync — Sync existing Shopify products into their mapped collections.
 * Loads all mappings once (no N+1), then processes products in batches.
 */
export async function POST() {
  try {
    const [products, mappings] = await Promise.all([
      getProductsWithShopifyId(),
      getAllCollectionMappings(),
    ]);
    const mappingMap = new Map(mappings.map(m => [m.aosomCategory, m]));

    let added = 0;
    let skipped = 0;
    let noMapping = 0;
    let errors = 0;
    const errorList: { sku: string; error: string }[] = [];

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      const mapping = findMappingForType(p.product_type, mappingMap);
      if (!mapping) {
        noMapping++;
        continue;
      }

      try {
        const existing = await getProductCollections(p.shopify_product_id);
        if (existing.includes(mapping.shopifyCollectionId)) {
          skipped++;
          continue;
        }

        await addProductToCollection(p.shopify_product_id, mapping.shopifyCollectionId);
        added++;

        // Rate limit: ~2 req/sec
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
