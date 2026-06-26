/**
 * Default per-template captions for slideshow/montage posts (Module G).
 *
 * This caption is what gets stored on the publication_queue row. At publish
 * time the publisher (src/lib/queue-publisher.ts → generateReelCaption) rewrites
 * it into fresh clickbait, FEEDING this text to Claude as the product context —
 * so the caption must carry real product material (a lead + a few product
 * names), never an empty string.
 */
import { SlideshowTemplate, type SlideshowItem, type SlideshowLanguage } from "./types";

/** Lead line per template, per language. */
const TEMPLATE_LEAD: Record<SlideshowTemplate, { fr: string; en: string }> = {
  [SlideshowTemplate.SHOWCASE]: { fr: "À la une", en: "Featured" },
  [SlideshowTemplate.BEST_SELLERS]: { fr: "Nos meilleurs vendeurs", en: "Our best sellers" },
  [SlideshowTemplate.PRICE_DROP]: { fr: "Rabais en cours", en: "On sale now" },
  [SlideshowTemplate.URGENCY]: { fr: "Presque épuisé", en: "Almost gone" },
  [SlideshowTemplate.LOOKBOOK]: { fr: "Notre sélection", en: "Our edit" },
  [SlideshowTemplate.DISCOVERY]: { fr: "À découvrir", en: "Worth discovering" },
  [SlideshowTemplate.COUNTDOWN]: { fr: "Édition spéciale", en: "Special edition" },
  [SlideshowTemplate.REMIX]: { fr: "On rejoue les favoris", en: "Replaying the favourites" },
};

/**
 * Build the default caption for a slideshow: a template lead followed by up to
 * three product names drawn from the slides. Replaced by clickbait at publish.
 */
export function getSlideshowCaption(
  template: SlideshowTemplate,
  language: SlideshowLanguage,
  items: SlideshowItem[],
): string {
  const lead = (TEMPLATE_LEAD[template] ?? TEMPLATE_LEAD[SlideshowTemplate.SHOWCASE])[language];
  const names = Array.from(
    new Set(items.map((i) => i.overlay_text?.trim()).filter((t): t is string => !!t)),
  ).slice(0, 3);
  return names.length > 0 ? `${lead} : ${names.join(", ")}` : lead;
}
