/**
 * Shared per-product Shopify fetch for the selector layer.
 *
 * `resolveProductImages` (shopify-images.ts) and `resolveProductTitleFr`
 * (shopify-titles.ts) each need the same live product record. `hydrateItems`
 * (map.ts) and `bestSellerImageSeries` resolve the title and the images for the
 * same product back-to-back, so fetching them independently meant TWO
 * `GET /products/{id}.json` calls per product.
 *
 * This module issues ONE `?fields=images,title` request, filters to the clean
 * Shopify-CDN hero photo(s), caches the combined `{ images, titleFr }`
 * per-product for 5 minutes, and throttles to Shopify's ~2 req/sec REST budget.
 * The two resolvers each read their field off this shared cache, so whichever
 * runs second is a cache hit — one Shopify request per product, not two.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { env } from "@/lib/config";
import { SHOPIFY_CDN_PREFIX } from "@/lib/slideshow/validate";

/** The subset of a live Shopify product the selector layer consumes. */
export interface ProductFields {
  /** Clean Shopify-CDN hero photo URLs (filtered, capped — see below). */
  images: string[];
  /** Live Shopify title (FR for this store), or "" when absent/unavailable. */
  titleFr: string;
}

const TTL_MS = 5 * 60 * 1000;
/** Shopify allows ~2 req/sec on REST; one request per 500ms stays safely under. */
const MIN_REQUEST_GAP_MS = 500;

const cache = new Map<string, { fields: ProductFields; expiry: number }>();

// Serialize Shopify requests through a single chain so concurrent selector calls
// (title + images, across products) can't burst past the rate limit.
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

/** Keep only the first image: Aosom always places the official white-background
 * product shot at gallery position 1 (index 0); lifestyle/ambiance and spec
 * shots sit at position 2+. One clean white-bg photo per product. */
const MAX_PRODUCT_IMAGES = 1;

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

/** Keep only cdn.shopify.com sources, drop spec/infographic shots, cap at
 * MAX_PRODUCT_IMAGES (the clean hero photos). */
function filterProductImages(images: { src?: string }[] | undefined): string[] {
  return (images ?? [])
    .map((img) => (typeof img.src === "string" ? img.src : ""))
    .filter((src) => src.startsWith(SHOPIFY_CDN_PREFIX) && !isSpecImageUrl(src))
    .slice(0, MAX_PRODUCT_IMAGES);
}

/**
 * Fetch a product's images + FR title in a single request (cached, throttled).
 * Returns `{ images: [], titleFr: "" }` on any failure (no token, 404, network)
 * so a missing field never breaks content selection.
 */
export async function resolveProductFields(shopifyProductId: string): Promise<ProductFields> {
  const id = (shopifyProductId || "").trim();
  if (!id) return { images: [], titleFr: "" };
  if (!env.hasShopifyToken) return { images: [], titleFr: "" };

  const hit = cache.get(id);
  if (hit && hit.expiry > Date.now()) return hit.fields;

  let fields: ProductFields = { images: [], titleFr: "" };
  try {
    await throttle();
    const res = await shopifyFetch(`/products/${encodeURIComponent(id)}.json?fields=images,title`);
    if (res.ok) {
      const data = (await res.json()) as {
        product?: { images?: { src?: string }[]; title?: string };
      };
      fields = {
        images: filterProductImages(data.product?.images),
        titleFr: typeof data.product?.title === "string" ? data.product.title.trim() : "",
      };
    }
  } catch {
    fields = { images: [], titleFr: "" };
  }

  cache.set(id, { fields, expiry: Date.now() + TTL_MS });
  return fields;
}

/** Test/maintenance helper: drop the per-product field cache. */
export function clearProductCache(): void {
  cache.clear();
}
