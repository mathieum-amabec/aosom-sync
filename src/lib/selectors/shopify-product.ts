/**
 * Shared per-product Shopify fetch for the selector layer.
 *
 * `resolveProductImages` (shopify-images.ts), `resolveLifestyle`
 * (shopify-images.ts) and `resolveProductTitleFr` (shopify-titles.ts) each need
 * the same live product record. `hydrateItems` (map.ts), `bestSellerImageSeries`,
 * and the social/image-preview paths resolve these fields for the same product,
 * so fetching them independently meant up to THREE `GET /products/{id}.json`
 * calls per product.
 *
 * This module issues ONE `?fields=images,title,tags` request, derives every
 * view (image hero, FR title, lifestyle tag + position-1 photo), caches the
 * combined result per-product for 5 minutes, and throttles to Shopify's
 * ~2 req/sec REST budget. Each resolver reads its slice off this shared cache,
 * so whichever runs second/third is a cache hit — one Shopify request per
 * product, not three.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { env } from "@/lib/config";
import { SHOPIFY_CDN_PREFIX } from "@/lib/slideshow/validate";

/** Lifestyle-verified status + the clean Shopify position-1 photo. */
export interface LifestyleInfo {
  verified: boolean;
  /** Shopify-CDN position-1 photo (spec/infographic shots dropped), or null. */
  primaryImageUrl: string | null;
}

/** The subset of a live Shopify product the selector layer consumes. */
export interface ProductFields {
  /** Clean Shopify-CDN hero photo URLs, array-order, capped (resolveProductImages). */
  images: string[];
  /** Live Shopify title (FR for this store), or "" when absent/unavailable. */
  titleFr: string;
  /** Lifestyle tag presence + position-sorted primary photo (resolveLifestyle). */
  lifestyle: LifestyleInfo;
  /** Live Shopify product handle (authoritative for the PDP URL), or null. */
  handle: string | null;
  /** Live Shopify product status ("active" | "draft" | "archived"), or null. */
  status: string | null;
  /** Live first-variant price as a string (e.g. "73.99"), or null. */
  price: string | null;
}

const TTL_MS = 5 * 60 * 1000;
/** Shopify allows ~2 req/sec on REST; one request per 500ms stays safely under. */
const MIN_REQUEST_GAP_MS = 500;

const cache = new Map<string, { fields: ProductFields; expiry: number }>();

// Serialize Shopify requests through a single chain so concurrent selector calls
// (images + title + lifestyle, across products) can't burst past the rate limit.
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

/** Shopify tag that marks a product's gallery as lifestyle-first (pos-1 swap). */
const LIFESTYLE_TAG = "lifestyle-verified";

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

type RawImage = { src?: string; position?: number };

/** Clean cdn.shopify.com sources (spec/infographic dropped), in the given order. */
function cleanCdnSrcs(images: RawImage[]): string[] {
  return images
    .map((img) => (typeof img.src === "string" ? img.src : ""))
    .filter((src) => src.startsWith(SHOPIFY_CDN_PREFIX) && !isSpecImageUrl(src));
}

const EMPTY_FIELDS = (): ProductFields => ({
  images: [],
  titleFr: "",
  lifestyle: { verified: false, primaryImageUrl: null },
  handle: null,
  status: null,
  price: null,
});

function computeFields(
  product:
    | {
        images?: RawImage[];
        title?: string;
        tags?: string;
        handle?: string;
        status?: string;
        variants?: Array<{ price?: string }>;
      }
    | undefined,
): ProductFields {
  const rawImages = product?.images ?? [];
  // resolveProductImages view: array-order (Aosom white-bg at index 0), capped.
  const images = cleanCdnSrcs(rawImages).slice(0, MAX_PRODUCT_IMAGES);
  // resolveLifestyle view: the clean photo at the lowest Shopify gallery position.
  const byPosition = rawImages.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const primaryImageUrl = cleanCdnSrcs(byPosition)[0] ?? null;
  const tags = (product?.tags ?? "").split(",").map((t) => t.trim().toLowerCase());
  const titleFr = typeof product?.title === "string" ? product.title.trim() : "";
  return {
    images,
    titleFr,
    lifestyle: { verified: tags.includes(LIFESTYLE_TAG), primaryImageUrl },
    handle: typeof product?.handle === "string" ? product.handle : null,
    status: typeof product?.status === "string" ? product.status : null,
    price: product?.variants?.[0]?.price ?? null,
  };
}

/**
 * Fetch a product's images + FR title + lifestyle info in a single request
 * (cached, throttled). Returns an empty result on any failure (no token, 404,
 * network) so a missing field never breaks content selection.
 */
export async function resolveProductFields(shopifyProductId: string): Promise<ProductFields> {
  const id = (shopifyProductId || "").trim();
  if (!id) return EMPTY_FIELDS();
  if (!env.hasShopifyToken) return EMPTY_FIELDS();

  const hit = cache.get(id);
  if (hit && hit.expiry > Date.now()) return hit.fields;

  let fields = EMPTY_FIELDS();
  try {
    await throttle();
    const res = await shopifyFetch(
      `/products/${encodeURIComponent(id)}.json?fields=images,title,tags,handle,status,variants`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        product?: {
          images?: RawImage[];
          title?: string;
          tags?: string;
          handle?: string;
          status?: string;
          variants?: Array<{ price?: string }>;
        };
      };
      fields = computeFields(data.product);
    }
  } catch {
    fields = EMPTY_FIELDS();
  }

  cache.set(id, { fields, expiry: Date.now() + TTL_MS });
  return fields;
}

/** Test/maintenance helper: drop the per-product field cache. */
export function clearProductCache(): void {
  cache.clear();
}
