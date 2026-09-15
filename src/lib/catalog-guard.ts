/**
 * Shared catalog-content guard: supplier-brand stripping and FR/EN language
 * detection. Single source of truth for content-generator.ts (write-time,
 * blocks a bad generation before it reaches Shopify) and
 * scripts/audit-catalog-consistency.mjs (read-only sweep of the live catalog),
 * so the two can never drift into disagreeing about what "clean" means.
 *
 * Background: the 2026-09 investigation found three related but distinct
 * customer-facing defects — English descriptions (diff-engine bug, fixed in
 * v0.5.92.3), supplier-brand leaks into descriptions (stripSupplierBrands was
 * only ever applied to titles/handles, never descriptions), and duplicate
 * EN/FR "Couleur" option values (fixed in variant-merger.ts). This module
 * guards the first two at the point content is generated.
 */

/** Supplier brand names that must never surface in customer-facing content
 * (titles, descriptions, URL handles). Canonical list — content-generator.ts
 * and the catalog audit script both import from here. */
export const SUPPLIER_BRANDS = [
  "Outsunny",
  "HOMCOM",
  "Aosom",
  "Vinsetto",
  "PawHut",
  "Soozier",
  "Qaba",
  "ShopEZ",
  "Wikinger",
  "Portland",
  "Aousthop",
  "DuraHand",
];

const SUPPLIER_BRAND_ALT = SUPPLIER_BRANDS.join("|");
const SUPPLIER_BRAND_RE = new RegExp(`\\b(?:${SUPPLIER_BRAND_ALT})\\b`, "gi");
// A French elision directly attached to the brand (l'Aosom, d'Aosom, qu'Aosom) has
// no space to anchor a plain word-boundary strip on, so "l'Aosom Audi" naively
// becomes the broken "l' Audi" — remove the whole elision+brand unit instead.
const SUPPLIER_BRAND_ELIDED_RE = new RegExp(
  `\\b(l|d|n|s|c|j|m|t|qu)['’](?:${SUPPLIER_BRAND_ALT})\\b\\s*`,
  "gi",
);

/**
 * Strip any supplier brand token from a string, including an elided form
 * ("l'Aosom", "d'Aosom") that a plain word-boundary strip would leave as a
 * dangling apostrophe. Safe to run on plain text, HTML, or a URL-handle
 * candidate before slugify() (which collapses the whitespace gaps left behind).
 */
export function stripSupplierBrands(s: string): string {
  return s
    .replace(SUPPLIER_BRAND_ELIDED_RE, "")
    .replace(SUPPLIER_BRAND_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}

/** Distinct forbidden supplier names present in `html`, lowercased, deduped. */
export function forbiddenBrandsIn(html: string | null | undefined): string[] {
  return [...new Set((html || "").match(SUPPLIER_BRAND_RE)?.map((s) => s.toLowerCase()) ?? [])];
}

// FR/EN detector: counts language-specific function words, frequent enough in any
// real product description to separate the two decisively. Ported from
// scripts/audit-description-language.mjs (validated 2026-09-11 against all 1382
// active products: 703 FR, 679 EN, zero MIXED, zero empty).
const FR_WORDS =
  /\b(vous|votre|vos|avec|pour|cette|cet|une|des|les|est|sont|plus|sans|dans|qui|que|aux|par|sur|peut|tout|toute)\b/g;
const FR_ACCENTED = /\b(très|déjà|qualité|matériau|conçu|résistant)\b/g;
const EN_WORDS =
  /\b(you|your|with|for|this|the|and|are|is|from|its|features|specification|includes|provides|easy|design|made)\b/g;

export type DescriptionLanguage = "FR" | "EN" | "MIXED" | "empty";

export function detectDescriptionLanguage(
  html: string | null | undefined,
): { fr: number; en: number; lang: DescriptionLanguage } {
  const text = (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const fr = (text.match(FR_WORDS) || []).length + (text.match(FR_ACCENTED) || []).length;
  const en = (text.match(EN_WORDS) || []).length;
  if (fr === 0 && en === 0) return { fr, en, lang: "empty" };
  if (en > fr * 1.5) return { fr, en, lang: "EN" };
  if (fr > en * 1.5) return { fr, en, lang: "FR" };
  return { fr, en, lang: "MIXED" };
}
