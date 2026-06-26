/**
 * Validation for slideshow configs — the safety gate every render path runs
 * before touching ffmpeg or the network.
 *
 * The single most important rule: every image URL must be a Shopify CDN URL.
 * Aosom's CDN (`img-us.aosomcdn.com`) 403s our render workers and supplier
 * imagery must never appear, so anything that is not `https://cdn.shopify.com/`
 * is rejected outright rather than fetched-and-failed.
 */
import {
  SlideshowTemplate,
  type SlideshowConfig,
  type SlideshowItem,
  type SlideshowRatio,
  type SlideshowBrand,
  type ValidationResult,
} from "./types";

/** The only image host a slide may use. */
export const SHOPIFY_CDN_PREFIX = "https://cdn.shopify.com/";

/** A discount badge is shown only when the saving is at least this fraction. */
export const MIN_DISCOUNT_RATIO = 1.1; // compare_at >= price * 1.10

export const MIN_ITEMS = 1;
export const MAX_ITEMS = 20;

const VALID_RATIOS: readonly SlideshowRatio[] = ["9:16", "1:1", "16:9"];
const VALID_BRANDS: readonly SlideshowBrand[] = ["ameublo", "furnish"];
const VALID_TEMPLATES: readonly string[] = Object.values(SlideshowTemplate);

/** True when `url` is a usable Shopify-CDN image URL. */
export function isShopifyCdnUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(SHOPIFY_CDN_PREFIX);
}

/**
 * Whether a discount badge should render for an item: a compare-at price that
 * is at least 10% above the current price. Centralizes the rule so the manifest,
 * the renderer, and the tests all agree.
 */
export function shouldShowBadge(price: number, compareAt?: number): boolean {
  return (
    typeof compareAt === "number" &&
    Number.isFinite(compareAt) &&
    Number.isFinite(price) &&
    price > 0 &&
    // Tolerance so an exact 10% (price * 1.10 = 110.00000000000001 in float) qualifies.
    compareAt >= price * MIN_DISCOUNT_RATIO - 1e-9
  );
}

/** Discount percentage (rounded) when a badge shows, else undefined. */
export function discountPct(price: number, compareAt?: number): number | undefined {
  if (!shouldShowBadge(price, compareAt)) return undefined;
  return Math.round(((compareAt as number) - price) / (compareAt as number) * 100);
}

function validateItem(item: SlideshowItem, index: number, errors: string[]): void {
  const at = `items[${index}]`;
  if (!isShopifyCdnUrl(item.image_url)) {
    errors.push(`${at}.image_url must start with ${SHOPIFY_CDN_PREFIX} (got "${item.image_url}")`);
  }
  if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price <= 0) {
    errors.push(`${at}.price must be a positive number (got ${item.price})`);
  }
  if (item.compare_at !== undefined && (typeof item.compare_at !== "number" || !Number.isFinite(item.compare_at))) {
    errors.push(`${at}.compare_at must be a finite number when present`);
  }
}

/**
 * Validate a slideshow config. Returns every problem found (does not short-
 * circuit) so a caller can surface them all at once.
 */
export function validateSlideshowConfig(config: SlideshowConfig): ValidationResult {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["config must be an object"] };
  }

  if (!Array.isArray(config.items) || config.items.length < MIN_ITEMS) {
    errors.push(`items must contain at least ${MIN_ITEMS} item`);
  } else if (config.items.length > MAX_ITEMS) {
    errors.push(`items must contain at most ${MAX_ITEMS} items (got ${config.items.length})`);
  } else {
    config.items.forEach((item, i) => validateItem(item, i, errors));
  }

  if (!VALID_RATIOS.includes(config.ratio)) {
    errors.push(`ratio must be one of ${VALID_RATIOS.join(", ")} (got "${config.ratio}")`);
  }

  if (!VALID_BRANDS.includes(config.brand)) {
    errors.push(`brand must be one of ${VALID_BRANDS.join(", ")} (got "${config.brand}")`);
  }

  // template feeds the Blob object key (blobPath); an unlisted value would let a
  // crafted string escape the slideshows/ prefix. Allowlist it (the enum is
  // erased at runtime, so a deserialized payload can carry anything).
  if (!VALID_TEMPLATES.includes(config.template as unknown as string)) {
    errors.push(`template must be one of ${VALID_TEMPLATES.join(", ")} (got "${config.template}")`);
  }

  if (config.language !== "fr" && config.language !== "en") {
    errors.push(`language must be "fr" or "en" (got "${config.language}")`);
  }

  return { valid: errors.length === 0, errors };
}
