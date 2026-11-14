/**
 * Internal, non-physical Shopify products (the "Garantie Tranquillité 2 ans" extended warranty) are sold
 * on the Online Store next to furniture but are not supplier products: no automation may draft, zero,
 * reprice or feed them. Every product-listing chokepoint calls this.
 */
export const INTERNAL_PRODUCT_TYPE = "Garantie";
export const INTERNAL_PRODUCT_TAG = "internal-warranty";

export function isInternalProduct(p: { product_type?: string | null; tags?: string | string[] | null }): boolean {
  if ((p.product_type ?? "").trim() === INTERNAL_PRODUCT_TYPE) return true;
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",");
  return tags.some((t) => t.trim().toLowerCase() === INTERNAL_PRODUCT_TAG);
}
