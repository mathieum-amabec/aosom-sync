/**
 * DISCOVERY — WoW / "découverte du moment".
 *
 * Surfaces surprising products via one of three strategies (Module B):
 *   - margin: deepest rabais (compare_at >= price * 1.15), best first;
 *   - new:    imported within the recency window, newest first;
 *   - random: a random imported-product sampling.
 */
import { wowDiscovery } from "@/lib/selectors";
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

export interface BuildDiscoveryOptions extends BaseTemplateOptions {
  /** Discovery strategy. */
  strategy: "margin" | "new" | "random";
  /**
   * Optional product_type hint. Accepted for API symmetry; wowDiscovery samples
   * the whole catalog by strategy, so category is currently advisory only.
   */
  category?: string;
  /** Number of products to feature (default 8). */
  limit?: number;
}

export async function buildDiscovery(opts: BuildDiscoveryOptions): Promise<SlideshowResult> {
  const language = resolveLanguage(opts);
  const limit = opts.limit ?? DEFAULT_ITEM_LIMIT;

  const products = await wowDiscovery({ strategy: opts.strategy, limit, language });
  const items = productsToSlideItems(products, language, limit);
  ensureItems(items, SlideshowTemplate.DISCOVERY);

  return renderTemplate({
    items,
    template: SlideshowTemplate.DISCOVERY,
    title: localized(language, "Découverte du moment ✨", "Today's discovery ✨"),
    language,
    opts,
  });
}
