import { SHOPIFY } from "./config";

export interface StoreLink {
  /** true when the product already exists in Shopify (has a shopify_product_id). */
  inStore: boolean;
  /** Deep link to the product, or null when not imported. */
  shopifyUrl: string | null;
}

/**
 * Map a product's Shopify product id to its store status + a deep link.
 *
 * "In store" links to the Shopify ADMIN product page (by numeric id), not the public
 * storefront `/products/{handle}`: the products table does not persist the storefront
 * handle, and deriving it from the name risks 404s (Shopify appends `-1` on collisions
 * and the generated `urlHandleFr` can differ from the title). The admin link is reliable
 * and matches the existing pattern in the import dashboard. If a storefront link is
 * wanted later, persist `shopify_handle` on import and switch the base URL here.
 *
 * "Not imported" returns shopifyUrl=null; the UI links those to the import dashboard.
 */
export function storeLink(
  shopifyProductId: string | number | null | undefined,
  adminBaseUrl: string = SHOPIFY.ADMIN_URL,
): StoreLink {
  const id = shopifyProductId == null ? "" : String(shopifyProductId).trim();
  const inStore = id.length > 0;
  return {
    inStore,
    shopifyUrl: inStore ? `${adminBaseUrl}/products/${id}` : null,
  };
}
