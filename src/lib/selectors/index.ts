/**
 * Content selectors (Module B) — barrel export.
 *
 * Each selector reads the catalog (Turso), returns normalized ProductItem[]
 * (Shopify-CDN images, derived compare-at), and caches results for 5 minutes.
 */
export * from "./types";
export { bestSellers } from "./best-sellers";
export { bestSellerImageSeries } from "./best-seller-image-series";
export { priceDrops } from "./price-drops";
export { lowStock } from "./low-stock";
export { wowDiscovery } from "./wow-discovery";
export { byCategory } from "./by-category";
export { seasonal, SEASONAL_THEMES } from "./seasonal";
export { productsBySkus } from "./by-skus";
export { clearSelectorCache } from "./cache";
export { resolveProductImages, clearImageCache } from "./shopify-images";
