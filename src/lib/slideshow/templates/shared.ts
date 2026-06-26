/**
 * Shared helpers for the six video templates (Module C).
 *
 * Every template follows the same shape:
 *   1. ask a content selector (Module B) for ProductItem[],
 *   2. map those to SlideshowItem[] (Shopify-CDN image + overlay copy), and
 *   3. delegate to renderSlideshow() (Module A) for validation + render/manifest.
 *
 * This module centralizes the mapping + the common render call so the templates
 * stay tiny and the host constraints are enforced in exactly one place:
 *   - image_url is always a https://cdn.shopify.com/ URL (products without a
 *     resolvable Shopify image are dropped — the renderer would reject them);
 *   - supplier brand names are stripped downstream by formatVideoTitle (render);
 *   - a discount badge shows only when compare_at >= price * 1.10 (render).
 */
import { renderSlideshow } from "@/lib/slideshow/render";
import {
  SlideshowTemplate,
  type SlideshowBrand,
  type SlideshowItem,
  type SlideshowLanguage,
  type SlideshowRatio,
  type SlideshowResult,
} from "@/lib/slideshow/types";
import { isShopifyCdnUrl } from "@/lib/slideshow/validate";
import type { ProductItem } from "@/lib/selectors";

/** Options every template accepts. `language` defaults from the brand. */
export interface BaseTemplateOptions {
  ratio: SlideshowRatio;
  brand: SlideshowBrand;
  /** Overlay language. Defaults: ameublo → "fr", furnish → "en". */
  language?: SlideshowLanguage;
  /** When true, returns a manifest and uploads/writes nothing. */
  dryRun?: boolean;
  /** Optional royalty-free music override; falls back to the bundled default. */
  musicUrl?: string;
}

/** Default number of product slides per slideshow (≈27s reel with intro/outro). */
export const DEFAULT_ITEM_LIMIT = 8;

/** Per-brand store display name for the intro card. */
const STORE_NAME: Record<SlideshowBrand, string> = {
  ameublo: "Ameublo Direct",
  furnish: "Furnish Direct",
};

/** FR-primary: ameublo is French, furnish is English, unless overridden. */
export function resolveLanguage(opts: BaseTemplateOptions): SlideshowLanguage {
  return opts.language ?? (opts.brand === "furnish" ? "en" : "fr");
}

/** Pick the FR or EN string for the active language (FR-primary). */
export function localized(language: SlideshowLanguage, fr: string, en: string): string {
  return language === "en" ? en : fr;
}

/** Intro-card title for SHOWCASE: store name + a short tagline. */
export function storeIntroTitle(brand: SlideshowBrand, language: SlideshowLanguage): string {
  const tagline = localized(language, "Meubles & déco à petit prix", "Furniture & decor for less");
  return `${STORE_NAME[brand]} · ${tagline}`;
}

/** Overlay title for a product, FR-primary with EN fallback to the FR name. */
export function productOverlayText(p: ProductItem, language: SlideshowLanguage): string {
  return language === "en" ? p.title_en || p.title_fr : p.title_fr || p.title_en;
}

/**
 * Map one product to a slide, or null when it has no Shopify-CDN image (such a
 * slide would be rejected by the renderer's validator).
 */
export function productToSlideItem(p: ProductItem, language: SlideshowLanguage): SlideshowItem | null {
  const image_url = p.images.find(isShopifyCdnUrl);
  if (!image_url) return null;
  return {
    image_url,
    overlay_text: productOverlayText(p, language),
    price: p.price,
    compare_at: p.compare_at_price,
    sku: p.sku,
  };
}

/**
 * Map products to slides, dropping any without a Shopify-CDN image and capping
 * at `max` slides.
 */
export function productsToSlideItems(
  products: ProductItem[],
  language: SlideshowLanguage,
  max: number = DEFAULT_ITEM_LIMIT,
): SlideshowItem[] {
  const items: SlideshowItem[] = [];
  for (const p of products) {
    const item = productToSlideItem(p, language);
    if (item) items.push(item);
    if (items.length >= max) break;
  }
  return items;
}

/** Guard with a clear, template-tagged error when nothing renderable remains. */
export function ensureItems(items: SlideshowItem[], template: SlideshowTemplate): void {
  if (items.length === 0) {
    throw new Error(`${template}: no products with a Shopify-CDN image available to render`);
  }
}

/** Build the SlideshowConfig from template inputs + base options and render it. */
export function renderTemplate(args: {
  items: SlideshowItem[];
  template: SlideshowTemplate;
  title: string;
  language: SlideshowLanguage;
  opts: BaseTemplateOptions;
}): Promise<SlideshowResult> {
  return renderSlideshow({
    items: args.items,
    template: args.template,
    ratio: args.opts.ratio,
    brand: args.opts.brand,
    language: args.language,
    title: args.title,
    musicUrl: args.opts.musicUrl,
    dryRun: args.opts.dryRun,
  });
}
