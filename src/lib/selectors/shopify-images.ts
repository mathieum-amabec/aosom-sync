/**
 * Resolve Shopify-CDN images for a catalog product.
 *
 * Why this exists: the catalog DB stores Aosom-CDN image URLs
 * (img-us.aosomcdn.com), which 403 our render workers and must never appear in
 * content. The live Shopify product, however, serves the same photos rehosted on
 * cdn.shopify.com. This module returns those, filtered to cdn.shopify.com only.
 *
 * The actual fetch/filter/cache/throttle lives in `shopify-product.ts`, shared
 * with the title resolver so both fields come from a single per-product request.
 *
 * A test seam (`__setImageResolverForTests`) lets the selector suite inject
 * deterministic images without hitting the network.
 */
import { resolveProductFields, isSpecImageUrl, clearProductCache } from "./shopify-product";

// Re-exported for callers/tests that import it from this module.
export { isSpecImageUrl };

/** A function that returns the Shopify-CDN image URLs for a product id. */
export type ImageResolver = (shopifyProductId: string) => Promise<string[]>;

/** Default resolver: the images slice of the shared per-product fetch. */
async function defaultResolveShopifyCdnImages(shopifyProductId: string): Promise<string[]> {
  return (await resolveProductFields(shopifyProductId)).images;
}

let resolver: ImageResolver = defaultResolveShopifyCdnImages;

/** Resolve a product's Shopify-CDN image URLs (cached, throttled). */
export function resolveProductImages(shopifyProductId: string): Promise<string[]> {
  return resolver(shopifyProductId);
}

/** Test-only: swap the resolver (pass null to restore the real one). */
export function __setImageResolverForTests(fn: ImageResolver | null): void {
  resolver = fn ?? defaultResolveShopifyCdnImages;
}

/** Test/maintenance helper: drop the per-product cache (shared with titles). */
export function clearImageCache(): void {
  clearProductCache();
}
