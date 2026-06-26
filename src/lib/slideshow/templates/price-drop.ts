/**
 * PRICE_DROP — "📉 Prix baissé".
 *
 * Pulls products with an active rabais of at least `minPct` (default 10%, the
 * same threshold the badge rule uses), so every slide shows a struck-through
 * compare-at price + the saving badge (drawn by the renderer).
 */
import { priceDrops } from "@/lib/selectors";
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

export interface BuildPriceDropOptions extends BaseTemplateOptions {
  /** Minimum discount percentage to qualify (default 10). Floored at 10. */
  minPct?: number;
  /** Number of products to feature (default 8). */
  limit?: number;
}

export async function buildPriceDrop(opts: BuildPriceDropOptions): Promise<SlideshowResult> {
  const language = resolveLanguage(opts);
  const limit = opts.limit ?? DEFAULT_ITEM_LIMIT;

  // The badge rule is fixed at 10% (compare_at >= price * 1.10). Floor minPct at
  // 10 so a sub-10 override can't feature non-badging products in a template
  // whose whole point is showing an active rabais — selector and overlay agree.
  const minPct = Math.max(10, opts.minPct ?? 10);
  const products = await priceDrops({ minPct, limit, language });
  const items = productsToSlideItems(products, language, limit);
  ensureItems(items, SlideshowTemplate.PRICE_DROP);

  return renderTemplate({
    items,
    template: SlideshowTemplate.PRICE_DROP,
    title: localized(language, "Prix baissés 📉", "Price drops 📉"),
    language,
    opts,
  });
}
