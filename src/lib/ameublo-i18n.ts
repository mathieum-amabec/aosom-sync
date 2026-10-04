/**
 * Language layer of the Ameublo videos. French = Ameublo Direct (ameublodirect.ca),
 * English = Furnish Direct (furnishdirect.ca, the EN locale of the same store, mascot "Furni").
 */

export type Lang = "fr" | "en";

export const MASCOT: Record<Lang, string> = { fr: "Ameublo", en: "Furni" };
export const SITE: Record<Lang, string> = { fr: "AMEUBLODIRECT.CA", en: "FURNISHDIRECT.CA" };

const FEMININE_ROOMS = new Set(["chambre", "terrasse"]);

export const STR = {
  fr: {
    freeShip: "LIVRAISON GRATUITE",
    tipHeader: "L’ASTUCE D’AMEUBLO",
    suggestion: "NOTRE SUGGESTION",
    guessHeader: "DEVINE LE PRIX",
    realPrice: "LE VRAI PRIX !",
    guessCta: "TU AVAIS DEVINÉ ? DIS-LE EN COMMENTAIRE",
    abHeader: "TU PRENDS LEQUEL ?",
    abCta: "ÉCRIS A OU B EN COMMENTAIRE",
    top3Hook: (cap: number) => `3 TROUVAILLES SOUS ${cap} $`,
    top3Cta: "TON PRÉFÉRÉ ?",
    pieceHook: (room: string, key = "") => (FEMININE_ROOMS.has(key) ? `TA ${room.toUpperCase()} COMPLÈTE EN 4 ARTICLES` : `TON ${room.toUpperCase()} COMPLET EN 4 ARTICLES`),
    total: "TOTAL",
    subtotal: "SOUS-TOTAL",
  },
  en: {
    freeShip: "FREE SHIPPING",
    tipHeader: "FURNI’S TIP",
    suggestion: "OUR PICK",
    guessHeader: "GUESS THE PRICE",
    realPrice: "THE REAL PRICE!",
    guessCta: "DID YOU GUESS? TELL US IN THE COMMENTS",
    abHeader: "WHICH ONE WOULD YOU PICK?",
    abCta: "COMMENT A OR B",
    top3Hook: (cap: number) => `3 FINDS UNDER $${cap}`,
    top3Cta: "YOUR FAVOURITE?",
    pieceHook: (room: string, _key = "") => `YOUR COMPLETE ${room.toUpperCase()} IN 4 PIECES`,
    total: "TOTAL",
    subtotal: "SUBTOTAL",
  },
} as const;

/** The rooms of "La pièce en 4 articles" are keyed by their French name. */
export const ROOM_LABEL: Record<string, Record<Lang, string>> = {
  salon: { fr: "salon", en: "living room" },
  bureau: { fr: "bureau", en: "home office" },
  chambre: { fr: "chambre", en: "bedroom" },
  cuisine: { fr: "coin repas", en: "dining nook" },
  terrasse: { fr: "terrasse", en: "patio" },
};

/** CAD the way each audience reads it: "84,99 $" vs "$84.99". */
export function priceFmt(n: number, lang: Lang): string {
  if (lang === "en") {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" }).format(n);
  }
  return new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" })
    .format(n)
    .replace(/[   ]/g, " ");
}

const DANGLING = /\s+(et|ou|avec|de|du|des|d’|d'|en|pour|à|au|aux|la|le|les|un|une|sur|and|or|with|for|of|in|the|a|an|to|&)$/i;

/** On-screen / caption title: cut at a clean word boundary (no "…", no dangling "and/avec"). */
export function tidyTitle(raw: string, max = 48): string {
  let t = raw.replace(/\s+/g, " ").replace(/[™®]/g, "").trim();
  if (t.length > max) {
    t = t.slice(0, max + 1).replace(/\s+\S*$/, "");
    const clause = Math.max(t.lastIndexOf(","), t.lastIndexOf(" — "), t.lastIndexOf(" – "), t.lastIndexOf(";"));
    if (clause >= max * 0.55) t = t.slice(0, clause);
    t = t.replace(/[\s,;:–—-]+$/, "").replace(/\s+\d{1,2}$/, "");
  }
  for (let i = 0; i < 3 && DANGLING.test(t); i++) t = t.replace(DANGLING, "").replace(/[\s,;:–—-]+$/, "");
  return t.replace(/[\s,;:–—-]+$/, "");
}

/** Supplier / manufacturer names never reach a client-facing frame. */
const FORBIDDEN = /\b(aosom|homcom|outsunny|qaba|pawhut|vinsetto|kleankin|costway|soozier|aiyaplay)\b[™®]?/gi;

/** Raw Aosom English titles are SEO-stuffed: keep the head of the title, drop brand names. */
export function cleanEnglishTitle(raw: string): string {
  const head = raw.replace(FORBIDDEN, "").replace(/\s{2,}/g, " ").trim();
  const cut = head.split(/\s*[,|–—]\s*|\s+with\s+|\s+&\s+/i)[0] ?? head;
  const t = (cut.length >= 12 ? cut : head).replace(/^[\s,-]+|[\s,-]+$/g, "");
  return t.length > 60 ? t.slice(0, 60).replace(/\s+\S*$/, "") : t;
}
