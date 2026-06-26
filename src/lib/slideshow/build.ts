/**
 * buildSlideshow — the Module G factory that ties the content selectors
 * (Module B) to the render engine (Module A).
 *
 * renderSlideshow() consumes a fully-resolved SlideshowConfig (it does NOT pick
 * products); the selectors return ProductItem[]. This factory bridges the two:
 * for a given template it calls the matching selector, maps each ProductItem to
 * a SlideshowItem (keeping only slides that have a usable Shopify-CDN image),
 * and hands the config to renderSlideshow for a dry-run manifest or a real MP4.
 *
 * Modules C–F (the richer template orchestration) are not built yet; this is the
 * minimal selection glue Module G needs to make every template renderable today.
 */
import {
  bestSellers,
  bestSellerImageSeries,
  priceDrops,
  lowStock,
  wowDiscovery,
  byCategory,
  seasonal,
  type ProductItem,
} from "@/lib/selectors";
import { renderSlideshow } from "./render";
import { isShopifyCdnUrl, MAX_ITEMS } from "./validate";
import {
  SlideshowTemplate,
  type SlideshowConfig,
  type SlideshowItem,
  type SlideshowResult,
  type SlideshowRatio,
  type SlideshowBrand,
  type SlideshowLanguage,
} from "./types";

/** Default number of products per slideshow (excludes intro/outro cards). */
const DEFAULT_LIMIT = 8;

type CategorySort = "velocity" | "price_asc" | "price_desc" | "discount";
type WowStrategy = "margin" | "new" | "random";

/** Options accepted by buildSlideshow. Template-specific knobs are all optional. */
export interface BuildSlideshowOptions {
  ratio?: SlideshowRatio;
  brand?: SlideshowBrand;
  language?: SlideshowLanguage;
  title?: string;
  /** Target total runtime in seconds (e.g. 6/15/30); the renderer paces to it. */
  durationSec?: number;
  dryRun?: boolean;
  /** Max products to include (capped at MAX_ITEMS). */
  limit?: number;
  /** Optional royalty-free music override. */
  musicUrl?: string;
  /** SHOWCASE: which SKU's multi-angle series to use (defaults to the top seller). */
  sku?: string;
  /** LOOKBOOK: product_type to feature, and the sort. */
  category?: string;
  sort?: CategorySort;
  /** PRICE_DROP: minimum discount percentage. */
  minPct?: number;
  /** URGENCY: stock threshold. */
  threshold?: number;
  /** DISCOVERY: which discovery strategy. */
  strategy?: WowStrategy;
  /** COUNTDOWN: seasonal theme key (see SEASONAL_THEMES). */
  theme?: string;
  /**
   * Explicit, pre-resolved slides. When provided they bypass selection entirely
   * (used for REMIX of a prior set, or any caller that already has items).
   */
  items?: SlideshowItem[];
}

/** True when `v` is one of the SlideshowTemplate enum values. */
export function isSlideshowTemplate(v: unknown): v is SlideshowTemplate {
  return typeof v === "string" && (Object.values(SlideshowTemplate) as string[]).includes(v);
}

/** Default overlay/caption language for a brand (ameublo → FR, furnish → EN). */
export function languageForBrand(brand: SlideshowBrand): SlideshowLanguage {
  return brand === "furnish" ? "en" : "fr";
}

/** Map a selector ProductItem to a renderable slide, or null when it has no Shopify-CDN image. */
function toSlide(p: ProductItem, language: SlideshowLanguage): SlideshowItem | null {
  const image_url = p.images.find(isShopifyCdnUrl);
  if (!image_url) return null; // no render-safe image → skip this product
  return {
    image_url,
    overlay_text: language === "en" ? p.title_en : p.title_fr,
    price: p.price,
    compare_at: p.compare_at_price,
    sku: p.sku,
  };
}

/** Map+filter a selector result to slides, capped at MAX_ITEMS. */
function toSlides(products: ProductItem[], language: SlideshowLanguage): SlideshowItem[] {
  const slides: SlideshowItem[] = [];
  for (const p of products) {
    const slide = toSlide(p, language);
    if (slide) slides.push(slide);
    if (slides.length >= MAX_ITEMS) break;
  }
  return slides;
}

/** SHOWCASE: one product, one slide per Shopify-CDN angle. */
async function showcaseSlides(
  opts: BuildSlideshowOptions,
  language: SlideshowLanguage,
  limit: number,
): Promise<SlideshowItem[]> {
  let sku = opts.sku?.trim();
  if (!sku) {
    const top = await bestSellers({ limit: 1, language });
    sku = top[0]?.sku;
  }
  if (!sku) return [];
  const series = await bestSellerImageSeries(sku);
  if (!series) return [];
  const text = language === "en" ? series.title_en : series.title_fr;
  return series.allImages
    .filter(isShopifyCdnUrl)
    .slice(0, Math.min(limit, MAX_ITEMS))
    .map((image_url) => ({
      image_url,
      overlay_text: text,
      price: series.price,
      compare_at: series.compare_at_price,
      sku: series.sku,
    }));
}

/**
 * Resolve the slides for a template via the matching content selector.
 * Returns [] when nothing qualifies (the caller turns that into a clear error).
 */
export async function selectSlidesForTemplate(
  template: SlideshowTemplate,
  opts: BuildSlideshowOptions,
): Promise<SlideshowItem[]> {
  const language = opts.language ?? languageForBrand(opts.brand ?? "ameublo");
  // A non-positive limit (e.g. 0 typed into the UI) means "use the default", not "zero products".
  const limit = Math.min(opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT, MAX_ITEMS);

  // Explicit slides bypass selection (REMIX / pre-resolved callers).
  if (opts.items && opts.items.length > 0) return opts.items.slice(0, MAX_ITEMS);

  switch (template) {
    case SlideshowTemplate.SHOWCASE:
      return showcaseSlides(opts, language, limit);
    case SlideshowTemplate.BEST_SELLERS:
      return toSlides(await bestSellers({ limit, language }), language);
    case SlideshowTemplate.PRICE_DROP:
      return toSlides(await priceDrops({ limit, language, minPct: opts.minPct }), language);
    case SlideshowTemplate.URGENCY:
      return toSlides(await lowStock({ limit, language, threshold: opts.threshold }), language);
    case SlideshowTemplate.LOOKBOOK:
      return toSlides(
        await byCategory({ limit, language, category: opts.category, sort: opts.sort ?? "velocity" }),
        language,
      );
    case SlideshowTemplate.DISCOVERY:
      return toSlides(await wowDiscovery({ limit, language, strategy: opts.strategy ?? "margin" }), language);
    case SlideshowTemplate.COUNTDOWN:
      return toSlides(await seasonal(opts.theme ?? "", { limit, language }), language);
    case SlideshowTemplate.REMIX:
      // REMIX replays a PRIOR rendered set (Modules C–F), which don't exist yet.
      // Explicit `items` are handled above; reaching here means there's nothing to
      // remix. Fail clearly rather than silently shipping a random montage captioned
      // as a curated "remix".
      throw new Error(
        "REMIX requires an explicit `items` set — no prior rendered set is available yet",
      );
    default:
      return [];
  }
}

/**
 * Module-G build result: the render output plus the resolved context the
 * publication layer needs (slides for caption material, brand/language/ratio).
 */
export interface BuiltSlideshow {
  result: SlideshowResult;
  items: SlideshowItem[];
  template: SlideshowTemplate;
  ratio: SlideshowRatio;
  brand: SlideshowBrand;
  language: SlideshowLanguage;
}

/**
 * Build (and, unless dryRun, render + upload) a slideshow for a template.
 *
 * dryRun → result.manifest describes the render (no I/O).
 * else   → result.blobUrl is the public Vercel Blob URL of the rendered MP4.
 *
 * Returns the resolved slides alongside the result so callers can derive a
 * caption / queue payload without re-selecting. Throws when no eligible products
 * resolve, or on an invalid render config.
 */
export async function buildSlideshow(
  template: SlideshowTemplate,
  opts: BuildSlideshowOptions = {},
): Promise<BuiltSlideshow> {
  const brand: SlideshowBrand = opts.brand ?? "ameublo";
  const language: SlideshowLanguage = opts.language ?? languageForBrand(brand);
  const ratio: SlideshowRatio = opts.ratio ?? "9:16";

  const items = await selectSlidesForTemplate(template, { ...opts, brand, language });
  if (items.length === 0) {
    throw new Error(
      `buildSlideshow: no eligible products for template ${template} ` +
        `(need ≥1 product with a Shopify-CDN image)`,
    );
  }

  const config: SlideshowConfig = {
    items,
    template,
    ratio,
    brand,
    language,
    title: opts.title,
    musicUrl: opts.musicUrl,
    targetDurationSec: opts.durationSec,
    dryRun: opts.dryRun,
  };
  const result = await renderSlideshow(config);
  return { result, items, template, ratio, brand, language };
}
