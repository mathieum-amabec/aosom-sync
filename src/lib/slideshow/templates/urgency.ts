/**
 * URGENCY — "Dernière chance / stock faible".
 *
 * Pulls low-stock products (qty > 0 AND qty <= threshold, default 5) and leads
 * each slide with a scarcity line ("Plus que X en stock !" / "Only X left!").
 *
 * Note: the core renderer (Module A) draws overlays in the fixed brand palette
 * (gold on navy); there is no per-template overlay color. Urgency emphasis is
 * therefore carried by the scarcity copy and the "Dernière chance 🔥" title card
 * rather than a red/orange overlay — changing the palette would mean editing the
 * shared render engine, which is out of this module's scope.
 */
import { lowStock } from "@/lib/selectors";
import { SlideshowTemplate, type SlideshowItem, type SlideshowLanguage, type SlideshowResult } from "@/lib/slideshow/types";
import { isShopifyCdnUrl } from "@/lib/slideshow/validate";
import {
  type BaseTemplateOptions,
  DEFAULT_ITEM_LIMIT,
  ensureItems,
  localized,
  renderTemplate,
  resolveLanguage,
} from "./shared";

export interface BuildUrgencyOptions extends BaseTemplateOptions {
  /** Stock at or below which a product counts as low (default 5). */
  threshold?: number;
  /** Number of products to feature (default 8). */
  limit?: number;
}

/** Scarcity overlay line for a given stock level. */
function scarcityText(stock: number | undefined, language: SlideshowLanguage): string {
  const n = typeof stock === "number" && Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : 0;
  return localized(language, `Plus que ${n} en stock !`, `Only ${n} left!`);
}

export async function buildUrgency(opts: BuildUrgencyOptions): Promise<SlideshowResult> {
  const language = resolveLanguage(opts);
  const limit = opts.limit ?? DEFAULT_ITEM_LIMIT;

  const products = await lowStock({ threshold: opts.threshold ?? 5, limit, language });

  const items: SlideshowItem[] = [];
  for (const p of products) {
    const image_url = p.images.find(isShopifyCdnUrl);
    if (!image_url) continue; // no Shopify-CDN image → the renderer would reject it
    items.push({
      image_url,
      overlay_text: scarcityText(p.stock, language),
      price: p.price,
      compare_at: p.compare_at_price,
      sku: p.sku,
    });
    if (items.length >= limit) break;
  }
  ensureItems(items, SlideshowTemplate.URGENCY);

  return renderTemplate({
    items,
    template: SlideshowTemplate.URGENCY,
    title: localized(language, "Dernière chance 🔥", "Last chance 🔥"),
    language,
    opts,
  });
}
