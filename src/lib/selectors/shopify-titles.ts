/**
 * Resolve the French product title for a catalog product.
 *
 * Why this exists: the catalog DB column `products.name` is the RAW ENGLISH
 * Aosom title (e.g. "3-Seater Outdoor Porch Swing with Adjustable Canopy…").
 * The store is French-primary, so the live Shopify product title is the curated
 * FR title ("Balancelle de patio 3 places avec auvent ajustable"). Slideshow
 * overlays must read FR for the ameublo brand, so this module returns the live
 * Shopify title.
 *
 * The actual fetch/cache/throttle lives in `shopify-product.ts`, shared with the
 * image resolver so both fields come from a single per-product request.
 *
 * A test seam (`__setTitleResolverForTests`) lets the selector suite inject
 * deterministic titles without hitting the network.
 */
import { resolveProductFields, clearProductCache } from "./shopify-product";

/** A function that returns the FR (Shopify) title for a product id, or "". */
export type TitleResolver = (shopifyProductId: string) => Promise<string>;

/** Default resolver: the title slice of the shared per-product fetch. */
async function defaultResolveShopifyTitle(shopifyProductId: string): Promise<string> {
  return (await resolveProductFields(shopifyProductId)).titleFr;
}

let resolver: TitleResolver = defaultResolveShopifyTitle;

/** Resolve a product's FR (Shopify) title (cached, throttled). "" when absent. */
export function resolveProductTitleFr(shopifyProductId: string): Promise<string> {
  return resolver(shopifyProductId);
}

/** Test-only: swap the resolver (pass null to restore the real one). */
export function __setTitleResolverForTests(fn: TitleResolver | null): void {
  resolver = fn ?? defaultResolveShopifyTitle;
}

/** Test/maintenance helper: drop the per-product cache (shared with images). */
export function clearTitleCache(): void {
  clearProductCache();
}
