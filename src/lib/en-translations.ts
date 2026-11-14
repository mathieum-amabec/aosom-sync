/**
 * EN product translations (Furnish Direct = the /en locale of the same store).
 *
 * The import pipeline writes the English copy to custom.* metafields, which the theme renders
 * for EN shoppers — but Shopify's own translation layer (used for the EN page <title>, and by
 * anything that reads Shopify translations: Google, feeds) stayed EMPTY, so it served the FRENCH
 * text on /en (audit 2026-09-28: 1421 / 1466 live products). This module turns that English copy
 * into real Shopify translations; shared by product creation (shopify-client.ts) and the
 * backfill script (scripts/register-en-product-translations.mts).
 */

/** Shopify translatable key → the custom.* metafield holding its English copy. */
export const EN_FIELD_MAP = {
  title: "title_en",
  body_html: "body_html_en",
  meta_title: "meta_title_en",
  meta_description: "meta_description_en",
} as const;
export type EnTranslatableKey = keyof typeof EN_FIELD_MAP;

const FORBIDDEN = /\b(aosom|outsunny|homcom|pawhut|vinsetto|qaba)\b/i;
/** A dollar amount — frozen at write time, so it goes stale (audit: 16 of 25 were wrong). */
const PRICE = /\$\s?\d|\d(?:[.,]\d{2})?\s?\$/;

/** True when a supposedly-English text reads as French (more FR than EN stop words). */
export function looksFrench(text: string): boolean {
  const t = ` ${text.replace(/<[^>]+>/g, " ").toLowerCase()} `;
  const count = (words: string[]) => words.reduce((n, w) => n + (t.split(` ${w} `).length - 1), 0);
  const fr = count(["le", "la", "les", "des", "est", "pour", "avec", "et", "une", "dans", "vous", "votre"]);
  const en = count(["the", "and", "with", "for", "is", "your", "you", "this", "to", "of", "in"]);
  return fr > en && fr >= 3;
}

/** Why an English value must NOT be registered, or null when it's safe. */
export function rejectEnValue(value: string): string | null {
  if (!value.trim()) return "vide";
  if (FORBIDDEN.test(value)) return "nom de fournisseur interdit";
  if (PRICE.test(value.replace(/<[^>]+>/g, " "))) return "contient un prix (risque d'être périmé)";
  if (looksFrench(value)) return "le texte « anglais » est en français";
  return null;
}
