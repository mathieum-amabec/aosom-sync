/**
 * Resolve the French product title for a catalog product.
 *
 * Why this exists: the catalog DB column `products.name` is the RAW ENGLISH
 * Aosom title (e.g. "3-Seater Outdoor Porch Swing with Adjustable Canopy…").
 * The store is French-primary, so the live Shopify product title is the curated
 * FR title ("Balancelle de patio 3 places avec auvent ajustable"). Slideshow
 * overlays must read FR for the ameublo brand, so this module fetches the live
 * Shopify title, caches it per-product for 5 minutes, and throttles to Shopify's
 * 2 req/sec budget — the same shape as shopify-images.ts.
 *
 * A test seam (`__setTitleResolverForTests`) lets the selector suite inject
 * deterministic titles without hitting the network.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { env } from "@/lib/config";

/** A function that returns the FR (Shopify) title for a product id, or "". */
export type TitleResolver = (shopifyProductId: string) => Promise<string>;

const TITLE_TTL_MS = 5 * 60 * 1000;
/** Shopify allows ~2 req/sec on REST; one request per 500ms stays safely under. */
const MIN_REQUEST_GAP_MS = 500;

const titleCache = new Map<string, { title: string; expiry: number }>();

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

/**
 * Default resolver: GET /products/{id}.json?fields=title and return the live
 * Shopify title (FR for this store). Returns "" on any failure (no token, 404,
 * network) so a missing title falls back to the catalog `name` upstream.
 */
async function defaultResolveShopifyTitle(shopifyProductId: string): Promise<string> {
  const id = (shopifyProductId || "").trim();
  if (!id) return "";
  if (!env.hasShopifyToken) return "";

  const hit = titleCache.get(id);
  if (hit && hit.expiry > Date.now()) return hit.title;

  let title = "";
  try {
    await throttle();
    const res = await shopifyFetch(`/products/${encodeURIComponent(id)}.json?fields=title`);
    if (res.ok) {
      const data = (await res.json()) as { product?: { title?: string } };
      title = typeof data.product?.title === "string" ? data.product.title.trim() : "";
    }
  } catch {
    title = "";
  }

  titleCache.set(id, { title, expiry: Date.now() + TITLE_TTL_MS });
  return title;
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

/** Test/maintenance helper: drop the per-product title cache. */
export function clearTitleCache(): void {
  titleCache.clear();
}
