/**
 * Resolve Shopify-CDN images + lifestyle status for a catalog product.
 *
 * Why this exists: the catalog DB stores Aosom-CDN image URLs
 * (img-us.aosomcdn.com), which 403 our render workers and must never appear in
 * content. The live Shopify product serves the same photos rehosted on
 * cdn.shopify.com. This module returns those, plus the lifestyle-verified tag +
 * position-1 photo used by the social/image-preview paths.
 *
 * The actual fetch/filter/cache/throttle lives in `shopify-product.ts`, shared
 * with the title resolver so images, title, and lifestyle info all come from a
 * single per-product request.
 *
 * Test seams (`__setImageResolverForTests`, `__setLifestyleResolverForTests`)
 * let the selector suite inject deterministic values without hitting the network.
 */
import { resolveProductFields, isSpecImageUrl, clearProductCache, type LifestyleInfo } from "./shopify-product";

// Re-exported for callers/tests that import them from this module.
export { isSpecImageUrl };
export type { LifestyleInfo };

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

/** Test/maintenance helper: drop the per-product cache (shared across resolvers). */
export function clearImageCache(): void {
  clearProductCache();
}

// ─── Lifestyle-verified resolution (tag + clean position-1 photo) ──────────
/**
 * A product is "lifestyle-verified" when it carries the Shopify tag
 * `lifestyle-verified`. For those products the Shopify gallery position-1 image is
 * the clean lifestyle photo — the pos-1 swap (scripts/lifestyle-pos1-fix.mjs)
 * reordered *Shopify* images only; the Aosom/Turso feed order (and thus
 * products.image1) is unaffected, so the lifestyle shot can ONLY be resolved from
 * Shopify, never from the catalog DB.
 */
export type LifestyleResolver = (shopifyProductId: string) => Promise<LifestyleInfo>;

/** Default resolver: the lifestyle slice of the shared per-product fetch. */
async function defaultResolveLifestyle(shopifyProductId: string): Promise<LifestyleInfo> {
  return (await resolveProductFields(shopifyProductId)).lifestyle;
}

let lifestyleResolver: LifestyleResolver = defaultResolveLifestyle;

/** Resolve a product's lifestyle-verified status + clean position-1 photo (cached, throttled). */
export function resolveLifestyle(shopifyProductId: string): Promise<LifestyleInfo> {
  return lifestyleResolver(shopifyProductId);
}

/** Test-only: swap the lifestyle resolver (pass null to restore the real one). */
export function __setLifestyleResolverForTests(fn: LifestyleResolver | null): void {
  lifestyleResolver = fn ?? defaultResolveLifestyle;
}

/** Test/maintenance helper: drop the per-product cache (shared across resolvers). */
export function clearLifestyleCache(): void {
  clearProductCache();
}
