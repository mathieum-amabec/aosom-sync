import type { AosomMergedProduct } from "@/types/aosom";
import type {
  ShopifyExistingProduct,
  ProductDiff,
  FieldChange,
  ChangeType,
} from "@/types/sync";

/**
 * Compare Aosom catalog (merged) against existing Shopify products.
 * Returns a list of diffs describing what needs to change.
 *
 * Match logic: Each Shopify variant has a SKU. We match Aosom variants
 * to Shopify variants by SKU, and group them by their parent Shopify product.
 */
export function computeDiffs(
  aosomProducts: AosomMergedProduct[],
  shopifyProducts: ShopifyExistingProduct[]
): ProductDiff[] {
  const diffs: ProductDiff[] = [];

  // Build Shopify lookup: SKU -> { product, variant }
  const shopifyBySku = new Map<
    string,
    { product: ShopifyExistingProduct; variantIndex: number }
  >();
  for (const product of shopifyProducts) {
    for (let i = 0; i < product.variants.length; i++) {
      const v = product.variants[i];
      if (v.sku) {
        shopifyBySku.set(v.sku, { product, variantIndex: i });
      }
    }
  }

  // Track which Shopify product IDs are still in the Aosom feed
  const seenShopifyIds = new Set<string>();

  // Build Aosom SKU set for removal detection
  const aosomSkus = new Set<string>();
  for (const merged of aosomProducts) {
    for (const v of merged.variants) {
      aosomSkus.add(v.sku);
    }
  }

  for (const aosom of aosomProducts) {
    // Find matching Shopify product(s) via SKU
    const matchedShopifyProducts = new Map<string, ShopifyExistingProduct>();
    for (const variant of aosom.variants) {
      const match = shopifyBySku.get(variant.sku);
      if (match) {
        matchedShopifyProducts.set(match.product.shopifyId, match.product);
      }
    }

    if (matchedShopifyProducts.size === 0) {
      // New product — not in Shopify yet
      diffs.push({
        shopifyId: null,
        groupKey: aosom.groupKey,
        productName: aosom.name,
        action: "create",
        changes: [
          {
            field: "new_product",
            sku: aosom.variants[0].sku,
            oldValue: null,
            newValue: aosom.name,
          },
        ],
        aosomProduct: aosom,
      });
      continue;
    }

    // Match found — check for changes against each matched Shopify product
    for (const [shopifyId, shopifyProduct] of matchedShopifyProducts) {
      seenShopifyIds.add(shopifyId);
      const changes = diffProduct(aosom, shopifyProduct);

      if (changes.length > 0) {
        diffs.push({
          shopifyId,
          groupKey: aosom.groupKey,
          productName: aosom.name,
          action: "update",
          changes,
          aosomProduct: aosom,
        });
      }
    }
  }

  // Products in Shopify but no longer in Aosom feed -> archive (draft)
  for (const shopifyProduct of shopifyProducts) {
    if (
      !seenShopifyIds.has(shopifyProduct.shopifyId) &&
      shopifyProduct.status === "active"
    ) {
      // Verify ALL variants are missing from Aosom (not just some)
      const allVariantsMissing = shopifyProduct.variants.every(
        (v) => !aosomSkus.has(v.sku)
      );

      if (allVariantsMissing) {
        diffs.push({
          shopifyId: shopifyProduct.shopifyId,
          groupKey: shopifyProduct.shopifyId,
          productName: shopifyProduct.title,
          action: "archive",
          changes: [
            {
              field: "removed_product",
              sku: shopifyProduct.variants[0]?.sku || "",
              oldValue: shopifyProduct.title,
              newValue: null,
            },
          ],
          aosomProduct: null,
        });
      }
    }
  }

  return diffs;
}

/**
 * Diff a single merged Aosom product against its Shopify counterpart.
 */
function diffProduct(
  aosom: AosomMergedProduct,
  shopify: ShopifyExistingProduct
): FieldChange[] {
  const changes: FieldChange[] = [];

  // Diff variant-level fields (price, stock)
  for (const aosomVariant of aosom.variants) {
    const shopifyVariant = shopify.variants.find(
      (v) => v.sku === aosomVariant.sku
    );

    if (!shopifyVariant) {
      changes.push({
        field: "new_variant",
        sku: aosomVariant.sku,
        oldValue: null,
        newValue: `${aosomVariant.color || ""} ${aosomVariant.size || ""}`.trim() || aosomVariant.sku,
      });
      continue;
    }

    // Price change
    if (Math.abs(shopifyVariant.price - aosomVariant.price) > 0.01) {
      changes.push({
        field: "price",
        sku: aosomVariant.sku,
        oldValue: shopifyVariant.price,
        newValue: aosomVariant.price,
      });
    }

    // Stock change
    if (shopifyVariant.inventoryQuantity !== aosomVariant.qty) {
      changes.push({
        field: "stock",
        sku: aosomVariant.sku,
        oldValue: shopifyVariant.inventoryQuantity,
        newValue: aosomVariant.qty,
      });
    }
  }

  // Check for removed variants (in Shopify but not in Aosom)
  for (const shopifyVariant of shopify.variants) {
    if (!aosom.variants.some((v) => v.sku === shopifyVariant.sku)) {
      changes.push({
        field: "removed_variant",
        sku: shopifyVariant.sku,
        oldValue:
          `${shopifyVariant.option1 || ""} ${shopifyVariant.option2 || ""}`.trim() || shopifyVariant.sku,
        newValue: null,
      });
    }
  }

  // Image change — compare sorted URL lists
  const aosomImgKey = aosom.images.slice().sort().join("|");
  const shopifyImgKey = shopify.images.slice().sort().join("|");
  if (aosomImgKey !== shopifyImgKey) {
    changes.push({
      field: "images",
      sku: aosom.variants[0].sku,
      oldValue: `${shopify.images.length} images`,
      newValue: `${aosom.images.length} images`,
    });
  }

  return changes;
}

/**
 * Summary stats from a diff set.
 */
export function summarizeDiffs(diffs: ProductDiff[]) {
  return {
    total: diffs.length,
    creates: diffs.filter((d) => d.action === "create").length,
    updates: diffs.filter((d) => d.action === "update").length,
    archives: diffs.filter((d) => d.action === "archive").length,
    priceChanges: diffs.reduce(
      (n, d) => n + d.changes.filter((c) => c.field === "price").length,
      0
    ),
    stockChanges: diffs.reduce(
      (n, d) => n + d.changes.filter((c) => c.field === "stock").length,
      0
    ),
    imageChanges: diffs.reduce(
      (n, d) => n + d.changes.filter((c) => c.field === "images").length,
      0
    ),
    // descriptionChanges is always 0 since diffProduct() no longer compares
    // descriptions. Kept here for backward compat and future re-introduction.
    descriptionChanges: diffs.reduce(
      (n, d) => n + d.changes.filter((c) => c.field === "description").length,
      0
    ),
  };
}
