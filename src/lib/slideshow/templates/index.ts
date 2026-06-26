/**
 * Video templates (Module C) — barrel export + factory.
 *
 * Each template selects products (Module B), maps them to slides, and delegates
 * to renderSlideshow (Module A). buildSlideshow() routes a SlideshowTemplate to
 * the matching builder.
 */
import { SlideshowTemplate, type SlideshowResult } from "@/lib/slideshow/types";
import { buildShowcase } from "./showcase";
import { buildBestSellers, type BuildBestSellersOptions } from "./best-sellers";
import { buildPriceDrop, type BuildPriceDropOptions } from "./price-drop";
import { buildUrgency, type BuildUrgencyOptions } from "./urgency";
import { buildLookbook, type BuildLookbookOptions } from "./lookbook";
import { buildDiscovery, type BuildDiscoveryOptions } from "./discovery";
import type { BaseTemplateOptions } from "./shared";

export * from "./shared";
export { buildShowcase } from "./showcase";
export { buildBestSellers, type BuildBestSellersOptions } from "./best-sellers";
export { buildPriceDrop, type BuildPriceDropOptions } from "./price-drop";
export { buildUrgency, type BuildUrgencyOptions } from "./urgency";
export { buildLookbook, type BuildLookbookOptions } from "./lookbook";
export { buildDiscovery, type BuildDiscoveryOptions } from "./discovery";

/** Union of every template's options, plus `sku` for SHOWCASE. */
export type BuildSlideshowOptions = BaseTemplateOptions &
  Partial<
    BuildBestSellersOptions &
      BuildPriceDropOptions &
      BuildUrgencyOptions &
      BuildLookbookOptions &
      Omit<BuildDiscoveryOptions, "strategy">
  > & {
    /** Required for SHOWCASE. */
    sku?: string;
    /** Required for DISCOVERY. */
    strategy?: BuildDiscoveryOptions["strategy"];
  };

/**
 * Build a slideshow for `template`, dispatching to the matching builder.
 *
 * @throws for templates not part of Module C (COUNTDOWN / REMIX), or when a
 * template-specific required option is missing (SHOWCASE needs `sku`, DISCOVERY
 * needs `strategy`).
 */
export async function buildSlideshow(
  template: SlideshowTemplate,
  opts: BuildSlideshowOptions,
): Promise<SlideshowResult> {
  switch (template) {
    case SlideshowTemplate.SHOWCASE: {
      if (!opts.sku) throw new Error("buildSlideshow(SHOWCASE): opts.sku is required");
      return buildShowcase(opts.sku, opts);
    }
    case SlideshowTemplate.BEST_SELLERS:
      return buildBestSellers(opts);
    case SlideshowTemplate.PRICE_DROP:
      return buildPriceDrop(opts);
    case SlideshowTemplate.URGENCY:
      return buildUrgency(opts);
    case SlideshowTemplate.LOOKBOOK:
      return buildLookbook(opts);
    case SlideshowTemplate.DISCOVERY: {
      if (!opts.strategy) throw new Error("buildSlideshow(DISCOVERY): opts.strategy is required");
      return buildDiscovery({ ...opts, strategy: opts.strategy });
    }
    default:
      throw new Error(
        `buildSlideshow: unsupported template "${template}" (COUNTDOWN/REMIX are not part of Module C)`,
      );
  }
}
