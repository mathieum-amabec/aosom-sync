/**
 * The shopper's language for the storefront assistant. `Locale` is the STORE (fr = Ameublo Direct, en = Furnish Direct);
 * `Lang` adds Spanish and Punjabi, which live on Furnish Direct (/es, /pa), so they use the "en" store locale for
 * branding and speak their own language. Before this, `locale: "es"|"pa"` fell through to French.
 *
 * Kept free of imports so routes can use it without pulling in the assistant engine (tests mock that module).
 */
export type Locale = "fr" | "en";
export type Lang = Locale | "es" | "pa";

export function parseLang(v: unknown): Lang {
  return v === "en" || v === "es" || v === "pa" ? v : "fr";
}

export const localeOf = (lang: Lang): Locale => (lang === "fr" ? "fr" : "en");

/** Pick the string for a language; es/pa fall back to English when a caller only wrote fr + en. */
export function byLang<T>(lang: Lang, s: { fr: T; en: T; es?: T; pa?: T }): T {
  return lang === "fr" ? s.fr : lang === "es" ? (s.es ?? s.en) : lang === "pa" ? (s.pa ?? s.en) : s.en;
}
