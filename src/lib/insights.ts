import { SHOPIFY } from "./config";

/** Public storefront base (FR). Storefront product URLs are /products/{handle}. */
export const STOREFRONT_BASE_URL = "https://ameublodirect.ca";

export interface StoreLink {
  /** true when the product already exists in Shopify (has a shopify_product_id or handle). */
  inStore: boolean;
  /** Deep link to the product, or null when not imported. */
  shopifyUrl: string | null;
}

/**
 * Map a product's Shopify identity to its store status + a deep link.
 *
 * Prefers the public storefront `/products/{handle}` when the handle is known
 * (persisted on import / via backfill). Falls back to the Shopify ADMIN product page
 * (by numeric id) when the handle isn't available yet — reliable, and matches the
 * import dashboard pattern. "Not imported" → shopifyUrl=null (UI links to /import).
 */
export function storeLink(
  shopifyProductId: string | number | null | undefined,
  shopifyHandle?: string | null,
  opts?: { adminBaseUrl?: string; storefrontBaseUrl?: string },
): StoreLink {
  const adminBaseUrl = opts?.adminBaseUrl ?? SHOPIFY.ADMIN_URL;
  const storefrontBaseUrl = opts?.storefrontBaseUrl ?? STOREFRONT_BASE_URL;
  const id = shopifyProductId == null ? "" : String(shopifyProductId).trim();
  const handle = shopifyHandle == null ? "" : String(shopifyHandle).trim();
  const inStore = id.length > 0 || handle.length > 0;

  let shopifyUrl: string | null = null;
  // Shopify handles are slug-safe ([a-z0-9-]); encodeURIComponent is defense-in-depth
  // since the handle comes from the Shopify API (backfill), not a local slugify.
  if (handle.length > 0) shopifyUrl = `${storefrontBaseUrl}/products/${encodeURIComponent(handle)}`;
  else if (id.length > 0) shopifyUrl = `${adminBaseUrl}/products/${id}`;

  return { inStore, shopifyUrl };
}
