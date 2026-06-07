/**
 * Bilingual blog topic catalogue + weekly selection.
 *
 * Each entry in {@link BILINGUAL_TOPICS} is the SAME subject expressed in both
 * languages, plus a shared English Unsplash query. The blog cron picks one
 * index per ISO week (`week % length`) so the FR and EN articles produced in a
 * single run are a translated pair: same subject, same photos, different
 * language. English image queries are intentional — Unsplash relevance is much
 * stronger in English, and a single shared query guarantees both articles can
 * draw from the same result set.
 *
 * Pure module (no I/O) so the synchronization logic is unit-testable.
 */

export type Language = "fr" | "en";

export interface BilingualTopic {
  /** Subject phrased in Quebec French (article title hint). */
  fr: string;
  /** The same subject phrased in English (article title hint). */
  en: string;
  /** English Unsplash search query, shared by both languages. */
  imageQuery: string;
}

// Index i = identical subject in FR and EN. Keep FR and EN entries true
// translations of each other; if you edit one side, edit the other.
export const BILINGUAL_TOPICS: readonly BilingualTopic[] = [
  { fr: "Aménager un salon cosy et chaleureux", en: "Creating a cozy, welcoming living room", imageQuery: "cozy living room interior" },
  { fr: "Mobilier extérieur tendance pour 2026", en: "Trending outdoor furniture for 2026", imageQuery: "modern outdoor patio furniture" },
  { fr: "Aménager un petit balcon urbain", en: "Styling a small urban balcony", imageQuery: "small balcony garden seating" },
  { fr: "Choisir un canapé durable et confortable", en: "Choosing a durable, comfortable sofa", imageQuery: "modern sofa living room" },
  { fr: "Créer un coin lecture cocooning", en: "Creating a cozy reading nook", imageQuery: "reading nook armchair" },
  { fr: "Organiser un bureau à domicile productif", en: "Setting up a productive home office", imageQuery: "home office desk setup" },
  { fr: "Décoration scandinave : le guide complet", en: "Scandinavian decor: the complete guide", imageQuery: "scandinavian interior design" },
  { fr: "Solutions de mobilier pour petits espaces", en: "Furniture solutions for small spaces", imageQuery: "small space apartment furniture" },
  { fr: "Aménager un potager surélevé", en: "Building a raised garden bed", imageQuery: "raised garden bed vegetables" },
  { fr: "Préparer son patio pour l'été", en: "Getting your patio summer-ready", imageQuery: "summer patio backyard furniture" },
  { fr: "Créer une chambre apaisante", en: "Designing a calming bedroom", imageQuery: "calm minimalist bedroom" },
  { fr: "Recevoir : une salle à manger conviviale", en: "Hosting: a welcoming dining room", imageQuery: "modern dining room table" },
  // ── 2026 expansion: décoration tendances, petits espaces, 4 saisons, entretien,
  // styles, enfants, rangement, animaux, budget, DIY ──
  { fr: "Les grandes tendances déco de 2026", en: "The biggest decor trends of 2026", imageQuery: "2026 interior design trends" },
  { fr: "Meubler un studio sans le surcharger", en: "Furnishing a studio apartment without clutter", imageQuery: "studio apartment small furniture" },
  { fr: "Mobilier extérieur 4 saisons pour l'hiver québécois", en: "All-season outdoor furniture for Canadian winters", imageQuery: "winter proof outdoor patio furniture" },
  { fr: "Entretenir et protéger vos meubles en bois", en: "Caring for and protecting wooden furniture", imageQuery: "wood furniture care cleaning" },
  { fr: "Nettoyer un canapé en tissu ou en cuir", en: "Cleaning fabric and leather sofas", imageQuery: "cleaning fabric leather sofa" },
  { fr: "Le style industriel : métal, bois et caractère", en: "Industrial style: metal, wood, and character", imageQuery: "industrial style loft interior" },
  { fr: "Créer une ambiance bohème chaleureuse", en: "Creating a warm bohemian atmosphere", imageQuery: "bohemian boho living room decor" },
  { fr: "Adopter un intérieur moderne et épuré", en: "Embracing a modern, minimalist interior", imageQuery: "modern minimalist interior" },
  { fr: "Choisir des meubles sécuritaires pour enfants", en: "Choosing safe furniture for kids", imageQuery: "kids room safe furniture" },
  { fr: "Aménager une chambre d'enfant évolutive", en: "Designing a kids' room that grows with them", imageQuery: "children bedroom furniture" },
  { fr: "Organiser une entrée fonctionnelle", en: "Organizing a functional entryway", imageQuery: "entryway storage organization" },
  { fr: "Maximiser le rangement dans une petite maison", en: "Maximizing storage in a small home", imageQuery: "home storage shelving organization" },
  { fr: "Des meubles qui résistent aux griffes des animaux", en: "Pet-friendly furniture that resists scratches", imageQuery: "pet friendly scratch resistant furniture" },
  { fr: "Aménager un coin confortable pour votre animal", en: "Creating a cozy corner for your pet", imageQuery: "cozy pet bed corner home" },
  { fr: "Décorer avec un petit budget", en: "Decorating on a small budget", imageQuery: "affordable budget home decor" },
  { fr: "Trouver des meubles abordables et durables", en: "Finding affordable, durable furniture", imageQuery: "affordable quality furniture" },
  { fr: "Personnaliser vos meubles : idées DIY faciles", en: "Personalizing your furniture: easy DIY ideas", imageQuery: "diy furniture makeover" },
  { fr: "Donner une seconde vie à vos vieux meubles", en: "Upcycling old furniture for a fresh look", imageQuery: "upcycled furniture restoration" },
];

// Stopwords stripped when deriving SEO keywords from a topic. Language-specific
// and intentionally small — kept here next to the topics they operate on.
const STOP_FR = new Set([
  "le", "la", "les", "un", "une", "de", "du", "des", "d", "et", "à", "au", "aux",
  "en", "avec", "pour", "sur", "dans", "par", "ou", "ce", "ces", "son", "sa",
  "ses", "nos", "votre", "notre", "comment", "guide", "complet", "conseils",
  "est", "sont", "plus", "mieux", "tout", "tous", "toute", "toutes",
]);

const STOP_EN = new Set([
  "a", "an", "the", "of", "in", "on", "for", "to", "and", "or", "with", "by",
  "how", "best", "guide", "tips", "your", "you", "is", "are", "what", "when",
  "where", "which", "that", "this", "these", "those", "at", "from", "right",
  "into", "creating", "setting", "getting", "building", "choosing", "styling",
  "designing", "hosting",
]);

/** ISO 8601 week number (1-53) for the given date, in UTC. */
export function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Up to 3 deduped SEO keywords derived from a topic, stopwords removed. */
export function extractKeywords(topic: string, lang: Language): string[] {
  const stops = lang === "fr" ? STOP_FR : STOP_EN;
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stops.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 3);
}

export interface WeeklyTopicSelection {
  /** Index into {@link BILINGUAL_TOPICS}. */
  idx: number;
  /** ISO week number that produced the selection. */
  week: number;
  /** FR title hint. */
  fr: string;
  /** EN title hint (same subject as {@link fr}). */
  en: string;
  /** Shared English Unsplash query. */
  imageQuery: string;
  keywordsFr: string[];
  keywordsEn: string[];
}

/**
 * Pick the bilingual topic for the week containing `date`. FR and EN are read
 * from the SAME index, so the pair always shares a subject.
 */
export function selectBilingualTopic(date: Date): WeeklyTopicSelection {
  const week = isoWeekNumber(date);
  const idx = week % BILINGUAL_TOPICS.length;
  const t = BILINGUAL_TOPICS[idx];
  return {
    idx,
    week,
    fr: t.fr,
    en: t.en,
    imageQuery: t.imageQuery,
    keywordsFr: extractKeywords(t.fr, "fr"),
    keywordsEn: extractKeywords(t.en, "en"),
  };
}
