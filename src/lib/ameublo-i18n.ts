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

/** English words that betray an untranslated French title (and their French replacement). */
const ANGLICISMS: [RegExp, string][] = [
  [/\bfarmhouse\b/gi, "fermette"],
  [/\bpantry\b/gi, "garde-manger"],
  [/\bhall tree\b/gi, "meuble d’entrée"],
  [/\bteddy fleece\b/gi, "peluche"],
  [/\bfleece\b/gi, "molleton"],
  [/\bteddy\b/gi, "peluche"],
  [/(\d+(?:[.,]\d+)?)\s*(?:"|”|″|inch(?:es)?\b)/gi, "$1 po"],
];
/** English words that must not survive in a French screen title (no safe translation: drop the cut). */
const ENGLISH_LEFTOVERS = /\b(with|and|storage|cabinet|chair|chairs|bench|mirror|shelf|shelves|stool|wooden|rustic|modern|industrial|cushion|drawers?|kitchen|bedroom|dining|tower|piece)\b/i;
/** French words that must not survive in an English screen title. */
const FRENCH_LEFTOVERS = /\b(avec|pour|rangement|armoire|chaises?|miroir|étagères?|tiroirs?|portes?|bois|noir|blanc|gris|style|du|des|et)\b/i;
const QTY = /\b(?:lot de \d+|ensemble de \d+|paire(?: de \d+)?|set of \d+|pack of \d+|\d+[- ]?(?:pack|pcs?|pieces?|pièces?))/i;
const BAD_END = /(?:\s(?:style|sans|dessus|dessous|hauteur|gain|ensemble|hautes?|bas|plus|total|inclus|compatible|and|with|pour|avec|et|ou|de|du|des|en|à|au|aux|sur|dans|par|le|la|les|un|une|w\/|x)|\sd[’']|[\/\-–—×])$/i;

function dedupeWords(t: string): string {
  return t.replace(/\b(\w{4,}(?:\s+\w{3,}){0,3})\s+\1\b/gi, "$1");
}

/** Replace known English words in a French title with their French equivalents. */
export function frenchify(t: string): string {
  let out = t;
  for (const [re, rep] of ANGLICISMS) out = out.replace(re, rep);
  return out;
}

/** True when a title reads as complete: no orphan word, number, dash, bracket or ellipsis at the end. */
export function endsClean(t: string): boolean {
  if (!t || /…|\.\.\./.test(t)) return false;
  if ((t.match(/\(/g)?.length ?? 0) !== (t.match(/\)/g)?.length ?? 0)) return false;
  if (BAD_END.test(t.trim())) return false;
  if (/\s\d+(?:[.,]\d+)?$/.test(t) && !/(?:lot de|ensemble de|set of|pack of|paire de)\s\d+$/i.test(t)) return false;
  if (/\/\s*[–—-]|[–—-]\s*\//.test(t)) return false;
  return true;
}

/**
 * On-screen / caption title. Cuts only at a clause boundary (comma, dash, "avec", "with", "et",
 * bracket…), never mid-phrase; keeps "lot de 2" / "set of 2" so the price is not read per unit;
 * returns null when no clean version fits in `max` characters — the planner then drops the product
 * rather than showing a half-sentence.
 */
export function cleanTitle(raw: string, lang: Lang, max = 48, extraFit?: (t: string) => boolean): string | null {
  let t = raw.replace(/\s+/g, " ").replace(/[™®]/g, "").trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (lang === "fr") t = frenchify(t);
  t = dedupeWords(t);
  const leftover = (x: string) => (lang === "fr" ? ENGLISH_LEFTOVERS.test(x) : FRENCH_LEFTOVERS.test(x));
  const fits = (x: string) => x.length <= max && endsClean(x) && !leftover(x) && (!extraFit || extraFit(x));
  if (fits(t)) return t;

  const qty = QTY.exec(t)?.[0] ?? null;
  const cuts: number[] = [];
  const sep = /\s*[,;|]\s*|\s+[–—-]\s+|\s*\(|\s+(?:avec|with|w\/|et|and|&|pour|for)\s+/gi;
  for (let m = sep.exec(t); m; m = sep.exec(t)) if (m.index > 0) cuts.push(m.index);
  for (const at of cuts.reverse()) {
    let head = t.slice(0, at).replace(/[\s,;:–—-]+$/, "");
    const dropped = t.slice(at);
    const SETWORD = /\b(set|ensemble|combo|bundle)\b/i;
    if (qty && !QTY.test(head) && QTY.test(dropped)) {
      const withQty = `${head}, ${qty}`;
      head = withQty.length <= max ? withQty : "";
    } else if (SETWORD.test(dropped) && !SETWORD.test(head)) {
      head = "";
    }
    if (head.length >= 10 && fits(head)) return head;
  }
  return null;
}

/** Legacy tolerant cut: always returns something (kept for older callers and tests). */
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
