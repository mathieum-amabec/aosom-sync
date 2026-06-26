/**
 * BEST_SELLERS — a carousel of the current top movers.
 *
 * Pulls the top products by 14-day stock-depletion velocity (Module B) and shows
 * one slide each (main Shopify-CDN image, title, price).
 */
import { bestSellers } from "@/lib/selectors";
import { SlideshowTemplate, type SlideshowResult } from "@/lib/slideshow/types";
import {
  type BaseTemplateOptions,
  DEFAULT_ITEM_LIMIT,
  ensureItems,
  localized,
  productsToSlideItems,
  renderTemplate,
  resolveLanguage,
} from "./shared";

export interface BuildBestSellersOptions extends BaseTemplateOptions {
  /** Number of products to feature (default 8). */
  limit?: number;
  /** Velocity window in days (default 14). */
  windowDays?: number;
}

export async function buildBestSellers(opts: BuildBestSellersOptions): Promise<SlideshowResult> {
  const language = resolveLanguage(opts);
  const limit = opts.limit ?? DEFAULT_ITEM_LIMIT;

  const products = await bestSellers({ limit, windowDays: opts.windowDays ?? 14, language });
  const items = productsToSlideItems(products, language, limit);
  ensureItems(items, SlideshowTemplate.BEST_SELLERS);

  return renderTemplate({
    items,
    template: SlideshowTemplate.BEST_SELLERS,
    title: localized(language, "Nos best-sellers du moment", "Our top picks right now"),
    language,
    opts,
  });
}
