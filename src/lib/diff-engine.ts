import type { AosomMergedProduct } from "@/types/aosom";
import type {
  ShopifyExistingProduct,
  ProductDiff,
  FieldChange,
} from "@/types/sync";
import { targetSellPrice } from "@/lib/pricing";

/**
 * Stock safety buffer applied before pushing Aosom quantity to Shopify inventory:
 * low supplier stock is treated as sold out, and a margin is shaved off the rest so
 * we never sell more than Aosom can ship.
 *   aosom_qty <= 5 → 0 (épuisé)
 *   aosom_qty  > 5 → aosom_qty - 3
 * Kept in one place so the daily sync (diff-engine), the apply path, and the one-time
 * backfill script agree. (The backfill .mjs inlines the same formula — keep in sync.)
 */
export function stockBufferQty(aosomQty: number): number {
  return aosomQty <= 5 ? 0 : aosomQty - 3;
}

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

  // Prioritize diffs that include a price change so money-affecting corrections drain
  // first out of the per-day Phase-2 chunk queue (image/description-only diffs follow).
  // Stable sort (V8): preserves original order within each group.
  const hasPrice = (d: ProductDiff) => (d.changes.some((c) => c.field === "price") ? 0 : 1);
  diffs.sort((a, b) => hasPrice(a) - hasPrice(b));

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

    // Price change — sell at the Aosom CSV price (0% markup) and NEVER below it.
    // targetSellPrice() floors the result at the Aosom price, so a Shopify price that
    // sits below the floor (e.g. a manual under-price) is force-corrected upward, and
    // we never emit a price under the Aosom floor. See src/lib/pricing.ts.
    const targetPrice = targetSellPrice(aosomVariant.price);
    // Skip when the Aosom price is missing/invalid — never push a $0/NaN price live.
    if (Number.isFinite(targetPrice) && targetPrice > 0 && Math.abs(shopifyVariant.price - targetPrice) > 0.01) {
      changes.push({
        field: "price",
        sku: aosomVariant.sku,
        oldValue: shopifyVariant.price,
        newValue: targetPrice,
      });
    }

    // Stock — push a safety-buffered quantity to Shopify inventory so we never sell
    // more than the supplier can actually ship. The buffer treats low Aosom stock as
    // sold-out and shaves a margin off the rest (see stockBufferQty). Only emit when the
    // buffered qty differs from Shopify's current available, so a stable qty doesn't
    // regenerate a no-op diff every run (the saturation risk that previously kept stock
    // out of the diff). applyToShopify pushes it via setInventoryLevel after ensuring the
    // variant is inventory-tracked.
    const safeQty = stockBufferQty(aosomVariant.qty);
    if (safeQty !== shopifyVariant.inventoryQuantity) {
      changes.push({
        field: "stock",
        sku: aosomVariant.sku,
        oldValue: shopifyVariant.inventoryQuantity,
        newValue: safeQty,
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

  // Description change — compare normalized HTML
  const aosomDesc = normalizeHtml(aosom.description);
  const shopifyDesc = normalizeHtml(shopify.bodyHtml);
  if (aosomDesc !== shopifyDesc) {
    changes.push({
      field: "description",
      sku: aosom.variants[0].sku,
      oldValue: truncate(shopify.bodyHtml, 100),
      newValue: truncate(aosom.description, 100),
    });
  }

  return changes;
}

function normalizeHtml(html: string): string {
  return (html || "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim()
    .toLowerCase();
}

function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
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
    descriptionChanges: diffs.reduce(
      (n, d) => n + d.changes.filter((c) => c.field === "description").length,
      0
    ),
  };
}
