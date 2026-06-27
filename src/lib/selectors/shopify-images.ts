/**
 * Resolve Shopify-CDN images for a catalog product.
 *
 * Why this exists: the catalog DB stores Aosom-CDN image URLs
 * (img-us.aosomcdn.com), which 403 our render workers and must never appear in
 * content. The live Shopify product, however, serves the same photos rehosted on
 * cdn.shopify.com. This module fetches those, filters to cdn.shopify.com only,
 * caches per-product for 5 minutes, and throttles to Shopify's 2 req/sec budget.
 *
 * A test seam (`__setImageResolverForTests`) lets the selector suite inject
 * deterministic images without hitting the network.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { env } from "@/lib/config";
import { SHOPIFY_CDN_PREFIX } from "@/lib/slideshow/validate";

/** A function that returns the Shopify-CDN image URLs for a product id. */
export type ImageResolver = (shopifyProductId: string) => Promise<string[]>;

const IMG_TTL_MS = 5 * 60 * 1000;
/** Shopify allows ~2 req/sec on REST; one request per 500ms stays safely under. */
const MIN_REQUEST_GAP_MS = 500;

const imgCache = new Map<string, { urls: string[]; expiry: number }>();

// Serialize Shopify requests through a single chain so concurrent selector calls
// can't burst past the rate limit.
let throttleChain: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const wait = throttleChain.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS - elapsed));
    }
    lastRequestAt = Date.now();
  });
  // Keep the chain alive even if a link rejects, so the throttle never wedges.
  throttleChain = wait.catch(() => undefined);
  return wait;
}

/** How many lead images to keep — the first 1-2 are the hero shots; specs/
 * infographics sit later in the Aosom gallery. */
const MAX_PRODUCT_IMAGES = 2;

/**
 * URL substrings that flag a spec/infographic/diagram image (case-insensitive),
 * plus the `-B0`..`-F0` filename suffixes Aosom uses for those gallery shots.
 * An image whose URL contains any of these is dropped — slideshows want clean
 * product photos, not measurement diagrams.
 */
const SPEC_IMAGE_KEYWORDS = [
  "diagram", "spec", "measure", "size", "dimension", "chart", "infographic",
  "instruction", "manual", "-b0", "-c0", "-d0", "-e0", "-f0",
];

/** True when the image URL looks like a spec/infographic shot, not a product photo. */
export function isSpecImageUrl(url: string): boolean {
  const u = url.toLowerCase();
  return SPEC_IMAGE_KEYWORDS.some((kw) => u.includes(kw));
}

/**
 * Default resolver: GET /products/{id}.json?fields=images, keep only
 * cdn.shopify.com sources, drop spec/infographic shots, and return the first
 * MAX_PRODUCT_IMAGES (the clean hero photos). Returns [] on any failure (no
 * token, 404, network) so a missing image never breaks content selection.
 */
async function defaultResolveShopifyCdnImages(shopifyProductId: string): Promise<string[]> {
  const id = (shopifyProductId || "").trim();
  if (!id) return [];
  if (!env.hasShopifyToken) return [];

  const hit = imgCache.get(id);
  if (hit && hit.expiry > Date.now()) return hit.urls;

  let urls: string[] = [];
  try {
    await throttle();
    const res = await shopifyFetch(`/products/${encodeURIComponent(id)}.json?fields=images`);
    if (res.ok) {
      const data = (await res.json()) as { product?: { images?: { src?: string }[] } };
      urls = (data.product?.images ?? [])
        .map((img) => (typeof img.src === "string" ? img.src : ""))
        .filter((src) => src.startsWith(SHOPIFY_CDN_PREFIX) && !isSpecImageUrl(src))
        .slice(0, MAX_PRODUCT_IMAGES);
    }
  } catch {
    urls = [];
  }

  imgCache.set(id, { urls, expiry: Date.now() + IMG_TTL_MS });
  return urls;
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

/** Test/maintenance helper: drop the per-product image cache. */
export function clearImageCache(): void {
  imgCache.clear();
}
