/**
 * SHOWCASE — a single hero product shown across its own image series.
 *
 * One SKU, one slide per Shopify-CDN image (max 8), with the product title,
 * price, and (when compare_at >= price * 1.10) a discount badge on every slide.
 * The intro card carries the store identity rather than the product name, so a
 * supplier brand can never surface on the title card.
 */
import { bestSellerImageSeries } from "@/lib/selectors";
import { SlideshowTemplate, type SlideshowItem, type SlideshowResult } from "@/lib/slideshow/types";
import { isShopifyCdnUrl } from "@/lib/slideshow/validate";
import {
  type BaseTemplateOptions,
  ensureItems,
  productOverlayText,
  renderTemplate,
  resolveLanguage,
  storeIntroTitle,
} from "./shared";

/** Maximum number of angles to show for the hero product. */
const MAX_SLIDES = 8;

/**
 * Build a SHOWCASE slideshow for one product.
 *
 * @param sku  The hero product's catalog SKU.
 * @throws when the SKU is unknown or has no Shopify-CDN imagery.
 */
export async function buildShowcase(sku: string, opts: BaseTemplateOptions): Promise<SlideshowResult> {
  const language = resolveLanguage(opts);

  const series = await bestSellerImageSeries(sku);
  if (!series) {
    throw new Error(`${SlideshowTemplate.SHOWCASE}: product not found for sku "${sku}"`);
  }

  const overlay = productOverlayText(series, language);
  const items: SlideshowItem[] = series.allImages
    .filter(isShopifyCdnUrl)
    .slice(0, MAX_SLIDES)
    .map((image_url) => ({
      image_url,
      overlay_text: overlay,
      price: series.price,
      compare_at: series.compare_at_price,
      sku: series.sku,
    }));

  ensureItems(items, SlideshowTemplate.SHOWCASE);

  return renderTemplate({
    items,
    template: SlideshowTemplate.SHOWCASE,
    title: storeIntroTitle(opts.brand, language),
    language,
    opts,
  });
}
