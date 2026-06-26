/**
 * Carousel template shortcuts (Module E).
 *
 * Thin builders that reuse the SAME content selectors as the video templates
 * (Module B) and feed their products into renderCarousel. Each maps the selector's
 * ProductItem[] to SlideshowItem[] (first Shopify-CDN photo, language-correct
 * title, derived compare-at), drops any product without a usable image, and
 * renders/uploads — or, with dryRun:true, returns a manifest.
 */
import { bestSellers, priceDrops, lowStock } from "@/lib/selectors";
import type { ProductItem } from "@/lib/selectors/types";
import { isShopifyCdnUrl } from "@/lib/slideshow/validate";
import type { SlideshowItem, SlideshowBrand, SlideshowLanguage } from "@/lib/slideshow/types";
import { renderCarousel } from "./render";
import type { CarouselFormat, CarouselResult } from "./types";

/** Common options for every carousel template. */
export interface CarouselBuildOptions {
  brand: SlideshowBrand;
  language: SlideshowLanguage;
  /** Output size. Default 1080x1080 (square feed). */
  format?: CarouselFormat;
  /** Max cards. Default 5. */
  limit?: number;
  /** Velocity / recency window (days) for selectors that use one. */
  windowDays?: number;
  /** When true, return a manifest and render/upload nothing. */
  dryRun?: boolean;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_FORMAT: CarouselFormat = "1080x1080";

/** Map a selector ProductItem to a carousel SlideshowItem (image not yet validated). */
function toSlideshowItem(p: ProductItem, language: SlideshowLanguage): SlideshowItem {
  return {
    image_url: p.images[0] ?? "",
    overlay_text: language === "en" ? p.title_en : p.title_fr,
    price: p.price,
    compare_at: p.compare_at_price,
    sku: p.sku,
  };
}

/** Convert products to slides, dropping any without a Shopify-CDN photo. */
function toItems(products: ProductItem[], language: SlideshowLanguage): SlideshowItem[] {
  return products.map((p) => toSlideshowItem(p, language)).filter((it) => isShopifyCdnUrl(it.image_url));
}

/** Render a carousel from already-selected products, or throw if none are usable. */
function renderFrom(products: ProductItem[], opts: CarouselBuildOptions, label: string): Promise<CarouselResult> {
  const items = toItems(products, opts.language);
  if (items.length === 0) {
    throw new Error(`${label}: no products with Shopify-CDN images`);
  }
  return renderCarousel({
    items,
    brand: opts.brand,
    language: opts.language,
    format: opts.format ?? DEFAULT_FORMAT,
    dryRun: opts.dryRun,
  });
}

/** Top movers by stock-depletion velocity. */
export async function buildBestSellersCarousel(opts: CarouselBuildOptions): Promise<CarouselResult> {
  const products = await bestSellers({ limit: opts.limit ?? DEFAULT_LIMIT, windowDays: opts.windowDays });
  return renderFrom(products, opts, "buildBestSellersCarousel");
}

/** Active rabais (compare_at >= price * 1.10), deepest discount first. */
export async function buildPriceDropCarousel(opts: CarouselBuildOptions): Promise<CarouselResult> {
  const products = await priceDrops({ limit: opts.limit ?? DEFAULT_LIMIT });
  return renderFrom(products, opts, "buildPriceDropCarousel");
}

/** Low-stock scarcity push, scarcest first. */
export async function buildUrgencyCarousel(opts: CarouselBuildOptions): Promise<CarouselResult> {
  const products = await lowStock({ limit: opts.limit ?? DEFAULT_LIMIT });
  return renderFrom(products, opts, "buildUrgencyCarousel");
}
