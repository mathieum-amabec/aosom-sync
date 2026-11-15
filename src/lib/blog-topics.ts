/**
 * Bilingual blog topic catalogue + per-run selection.
 *
 * Each entry in {@link BILINGUAL_TOPICS} is the SAME subject expressed in both
 * languages, plus a shared English Unsplash query. The blog cron picks one
 * index per run (Mon + Thu) so the FR and EN articles produced in a single run
 * are a translated pair: same subject, same photos, same products, different
 * language. English image queries are intentional — Unsplash relevance is much
 * stronger in English, and a single shared query guarantees both articles can
 * draw from the same result set.
 *
 * Since 2026-11 the catalogue is commercial and season-first: topics carry an
 * optional Shopify `collection` whose products are recommended in the article,
 * and {@link selectBilingualTopic} prefers an in-season seasonal topic (Christmas
 * trees in November, patio sets in May) over an evergreen one, never picks an
 * out-of-season topic, and never repeats a seasonal topic within the same season.
 *
 * Pure module (no I/O) so the selection logic is unit-testable.
 */

export type Language = "fr" | "en";

/**
 * Window a topic is relevant to publish in. "all" = evergreen (any time).
 * - spring Mar-May, summer Jun-Aug, fall Sep-Nov, winter Dec-Feb (calendar seasons, see {@link seasonOf});
 * - holidays: Nov 1 - Dec 20 (the Christmas shopping window — a gift guide on Dec 28 sells nothing);
 * - cold: Nov-Feb (the Quebec cold months: fireplaces, boots in the entryway, indoor pets);
 * - outdoor: Apr-Aug (patio / garden buying season).
 */
export type Season = "spring" | "summer" | "fall" | "winter" | "holidays" | "cold" | "outdoor" | "all";

export interface BilingualTopic {
  /** Subject phrased in Quebec French (article title hint). */
  fr: string;
  /** The same subject phrased in English (article title hint). */
  en: string;
  /** English Unsplash search query, shared by both languages. */
  imageQuery: string;
  /**
   * Window this topic should auto-publish in. Evergreen topics are "all"; seasonal ones are only ever
   * SELECTED inside their window (and the auto-publish gate re-checks it). See {@link isTopicInSeason}.
   */
  season: Season;
  /**
   * Shopify collection handle whose available products the article recommends (prompt context + a
   * server-side "Nos suggestions" block). Every handle here was verified to exist and hold sellable
   * products on 2026-11-15.
   */
  collection?: string;
  /**
   * Case-insensitive regex source matched against the FR product title to keep the picks on-topic
   * (e.g. only electric fireplaces, not fireplace tool sets). Non-matching products only top up the
   * picks when too few match.
   */
  productTitlePattern?: string;
  /** Other collection handles the article may link to (e.g. dining chairs next to tables). */
  relatedCollections?: readonly string[];
}

// Index i = identical subject in FR and EN. Keep FR and EN entries true
// translations of each other; if you edit one side, edit the other.
// Topics are only APPENDED: the index is logged per run, so reordering would make old logs misleading.
export const BILINGUAL_TOPICS: readonly BilingualTopic[] = [
  { fr: "Aménager un salon cosy et chaleureux", en: "Creating a cozy, welcoming living room", imageQuery: "cozy living room interior", season: "all", collection: "meubles-salon" },
  { fr: "Mobilier extérieur tendance pour 2026", en: "Trending outdoor furniture for 2026", imageQuery: "modern outdoor patio furniture", season: "summer", collection: "patio-mobilier" },
  { fr: "Aménager un petit balcon urbain", en: "Styling a small urban balcony", imageQuery: "small balcony garden seating", season: "summer", collection: "patio-mobilier" },
  { fr: "Choisir un canapé durable et confortable", en: "Choosing a durable, comfortable sofa", imageQuery: "modern sofa living room", season: "all", collection: "fauteuils-et-canapes" },
  { fr: "Créer un coin lecture cocooning", en: "Creating a cozy reading nook", imageQuery: "reading nook armchair", season: "all" },
  { fr: "Organiser un bureau à domicile productif", en: "Setting up a productive home office", imageQuery: "home office desk setup", season: "all", collection: "bureau-et-travail", productTitlePattern: "^bureau" },
  { fr: "Décoration scandinave : le guide complet", en: "Scandinavian decor: the complete guide", imageQuery: "scandinavian interior design", season: "all" },
  { fr: "Solutions de mobilier pour petits espaces", en: "Furniture solutions for small spaces", imageQuery: "small space apartment furniture", season: "all" },
  { fr: "Aménager un potager surélevé", en: "Building a raised garden bed", imageQuery: "raised garden bed vegetables", season: "spring", collection: "jardinieres-surelevees" },
  { fr: "Préparer son patio pour l'été", en: "Getting your patio summer-ready", imageQuery: "summer patio backyard furniture", season: "spring", collection: "patio-mobilier" },
  { fr: "Créer une chambre apaisante", en: "Designing a calming bedroom", imageQuery: "calm minimalist bedroom", season: "all" },
  { fr: "Recevoir : une salle à manger conviviale", en: "Hosting: a welcoming dining room", imageQuery: "modern dining room table", season: "all", collection: "cuisine-tables-a-manger", relatedCollections: ["cuisine-chaises-salle-a-manger"] },
  // ── 2026 expansion: décoration tendances, petits espaces, 4 saisons, entretien,
  // styles, enfants, rangement, animaux, budget, DIY ──
  { fr: "Les grandes tendances déco de 2026", en: "The biggest decor trends of 2026", imageQuery: "2026 interior design trends", season: "all" },
  { fr: "Meubler un studio sans le surcharger", en: "Furnishing a studio apartment without clutter", imageQuery: "studio apartment small furniture", season: "all" },
  { fr: "Mobilier extérieur 4 saisons pour l'hiver québécois", en: "All-season outdoor furniture for Canadian winters", imageQuery: "winter proof outdoor patio furniture", season: "winter" },
  { fr: "Entretenir et protéger vos meubles en bois", en: "Caring for and protecting wooden furniture", imageQuery: "wood furniture care cleaning", season: "all" },
  { fr: "Nettoyer un canapé en tissu ou en cuir", en: "Cleaning fabric and leather sofas", imageQuery: "cleaning fabric leather sofa", season: "all" },
  { fr: "Le style industriel : métal, bois et caractère", en: "Industrial style: metal, wood, and character", imageQuery: "industrial style loft interior", season: "all" },
  { fr: "Créer une ambiance bohème chaleureuse", en: "Creating a warm bohemian atmosphere", imageQuery: "bohemian boho living room decor", season: "all" },
  { fr: "Adopter un intérieur moderne et épuré", en: "Embracing a modern, minimalist interior", imageQuery: "modern minimalist interior", season: "all" },
  { fr: "Choisir des meubles sécuritaires pour enfants", en: "Choosing safe furniture for kids", imageQuery: "kids room safe furniture", season: "all" },
  { fr: "Aménager une chambre d'enfant évolutive", en: "Designing a kids' room that grows with them", imageQuery: "children bedroom furniture", season: "all" },
  { fr: "Organiser une entrée fonctionnelle", en: "Organizing a functional entryway", imageQuery: "entryway storage organization", season: "all", collection: "rangement-range-chaussures" },
  { fr: "Maximiser le rangement dans une petite maison", en: "Maximizing storage in a small home", imageQuery: "home storage shelving organization", season: "all" },
  { fr: "Des meubles qui résistent aux griffes des animaux", en: "Pet-friendly furniture that resists scratches", imageQuery: "pet friendly scratch resistant furniture", season: "all", collection: "arbres-a-chat" },
  { fr: "Aménager un coin confortable pour votre animal", en: "Creating a cozy corner for your pet", imageQuery: "cozy pet bed corner home", season: "all" },
  { fr: "Décorer avec un petit budget", en: "Decorating on a small budget", imageQuery: "affordable budget home decor", season: "all" },
  { fr: "Trouver des meubles abordables et durables", en: "Finding affordable, durable furniture", imageQuery: "affordable quality furniture", season: "all" },
  { fr: "Personnaliser vos meubles : idées DIY faciles", en: "Personalizing your furniture: easy DIY ideas", imageQuery: "diy furniture makeover", season: "all" },
  { fr: "Donner une seconde vie à vos vieux meubles", en: "Upcycling old furniture for a fresh look", imageQuery: "upcycled furniture restoration", season: "all" },
  // ── 2026-11 commercial, seasonal topics tied to a real collection ──
  // Holidays (Nov 1 - Dec 20)
  { fr: "Choisir le bon sapin de Noël artificiel", en: "Choosing the right artificial Christmas tree", imageQuery: "artificial christmas tree living room", season: "holidays", collection: "noel-sapins", productTitlePattern: "^(sapin|arbre de no)" },
  { fr: "Décorations de Noël extérieures pour le balcon et la cour", en: "Outdoor Christmas decorations for your balcony and yard", imageQuery: "outdoor christmas decorations porch lights", season: "holidays", collection: "noel-decorations" },
  { fr: "Idées cadeaux de Noël pour chaque pièce de la maison", en: "Christmas gift ideas for every room in the house", imageQuery: "christmas gifts home decor", season: "holidays", collection: "black-friday-cadeaux-noel" },
  { fr: "Recevoir pour les Fêtes : table extensible et chaises d'appoint", en: "Holiday hosting: extendable tables and extra chairs", imageQuery: "holiday dinner table setting", season: "holidays", collection: "cuisine-tables-a-manger", productTitlePattern: "extensible|rallonge|pliante", relatedCollections: ["cuisine-chaises-salle-a-manger"] },
  { fr: "Accueillir la visite des Fêtes : canapé-lit et futon", en: "Hosting holiday guests: sofa beds and futons", imageQuery: "sofa bed guest room", season: "holidays", collection: "fauteuils-et-canapes", productTitlePattern: "lit|futon|convertible" },
  // Cold months (Nov - Feb)
  { fr: "Chauffer une pièce en hiver avec un foyer électrique", en: "Warming up a room in winter with an electric fireplace", imageQuery: "electric fireplace cozy living room", season: "cold", collection: "foyers-interieurs", productTitlePattern: "^foyer .*lectrique|encastr" },
  { fr: "Entrée d'hiver : banc à bottes et range-chaussures", en: "Winter entryway: boot benches and shoe cabinets", imageQuery: "entryway bench boots winter", season: "cold", collection: "rangement-range-chaussures", relatedCollections: ["rangement-poufs-bancs"] },
  { fr: "Un salon douillet pour passer l'hiver", en: "A snug living room to get through winter", imageQuery: "warm winter living room blanket", season: "cold", collection: "meubles-salon" },
  { fr: "Garder son chat actif à l'intérieur pendant l'hiver", en: "Keeping your indoor cat active through winter", imageQuery: "cat tree indoor cat", season: "cold", collection: "arbres-a-chat" },
  { fr: "Télétravail en hiver : un bureau lumineux et confortable", en: "Working from home in winter: a bright, comfortable office", imageQuery: "bright home office winter window", season: "cold", collection: "bureau-et-travail", productTitlePattern: "^bureau" },
  // Spring / summer buying season
  { fr: "Choisir un ensemble de patio pour la belle saison", en: "Choosing a patio set for the warm season", imageQuery: "patio dining set backyard", season: "outdoor", collection: "patio-mobilier", productTitlePattern: "^(ensemble|salon|mobilier|table|bistro)" },
  { fr: "Gazébo ou pergola : créer de l'ombre sur le patio", en: "Gazebo or pergola: adding shade to your patio", imageQuery: "backyard gazebo pergola shade", season: "outdoor", collection: "gazebos-et-pergolas", productTitlePattern: "^(gaz|pergola)" },
  { fr: "Choisir une remise de jardin pour ranger ses outils", en: "Choosing a garden shed to store your tools", imageQuery: "garden shed backyard storage", season: "spring", collection: "patio-remises-jardin" },
  // (raised garden beds: the spring topic "Aménager un potager surélevé" above carries `jardinieres-surelevees`)
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

/**
 * Stable per-week key (`YYYY-Www`) used to scope the weekly publish counter. The year is
 * the ISO-week year (the year of that week's Thursday — the same pivot isoWeekNumber uses),
 * NOT the plain calendar year, so the Dec/Jan boundary never splits one ISO week across two
 * keys (e.g. 2025-12-31 is ISO 2026-W01, keyed "2026-W01"). That keeps the weekly cap exact
 * across year boundaries.
 */
export function isoWeekKey(d: Date): string {
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum); // shift to the week's Thursday
  return `${thursday.getUTCFullYear()}-W${String(isoWeekNumber(d)).padStart(2, "0")}`;
}

/**
 * Map a 0-indexed month (as from `Date#getUTCMonth`) to a calendar season. Same boundaries the
 * social content generator uses: spring Mar-May, summer Jun-Aug, fall Sep-Nov, winter Dec-Feb.
 */
export function seasonOf(month: number): "spring" | "summer" | "fall" | "winter" {
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "fall";
  return "winter";
}

/** Approximate length in days of each window — shorter windows are served first (they expire sooner). */
const WINDOW_DAYS: Record<Season, number> = {
  holidays: 50,
  spring: 92,
  summer: 92,
  fall: 91,
  winter: 90,
  cold: 120,
  outdoor: 153,
  all: 366,
};

/** Is a `season` window active on `date` (UTC)? Evergreen ("all") is always active. */
export function isSeasonActive(season: Season, date: Date): boolean {
  const m = date.getUTCMonth();
  switch (season) {
    case "all":
      return true;
    case "holidays":
      return m === 10 || (m === 11 && date.getUTCDate() <= 20);
    case "cold":
      return m >= 10 || m <= 1;
    case "outdoor":
      return m >= 3 && m <= 7;
    default:
      return season === seasonOf(m);
  }
}

/** Is `topic` appropriate to publish on `date`? Evergreen ("all") topics always are. */
export function isTopicInSeason(topic: BilingualTopic, date: Date): boolean {
  return isSeasonActive(topic.season, date);
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
  /** Which run within the week produced this selection (0 = early, 1 = late). */
  slot: number;
  /** Global run counter (2 per week since {@link RUN_ORIGIN}). */
  run: number;
  /** FR title hint. */
  fr: string;
  /** EN title hint (same subject as {@link fr}). */
  en: string;
  /** Shared English Unsplash query. */
  imageQuery: string;
  /** Season window this topic should auto-publish in (or "all"). */
  season: Season;
  /** Shopify collection whose products the article recommends, if any. */
  collection?: string;
  productTitlePattern?: string;
  relatedCollections?: readonly string[];
  keywordsFr: string[];
  keywordsEn: string[];
}

/**
 * How many blog runs happen per ISO week. The cron fires Mon + Thu, and BOTH land in the
 * same ISO week — so an index derived from the week number alone would hand both runs the
 * SAME topic and publish duplicate articles. The run slot below breaks that tie.
 */
export const RUNS_PER_WEEK = 2;

/**
 * Which run of the week a date belongs to: Mon-Wed → 0 (the early run), Thu-Sun → 1 (the
 * late run). Total over all 7 days so a manual trigger on any day still resolves, and
 * constant per weekday so the selection stays deterministic.
 */
export function runSlotOf(date: Date): number {
  const day = date.getUTCDay(); // 0 = Sunday
  return day === 0 || day >= 4 ? 1 : 0;
}

const DAY_MS = 86_400_000;
/** Monday 2020-01-06 — origin of the global run counter. */
export const RUN_ORIGIN = new Date(Date.UTC(2020, 0, 6));
/**
 * First run (Mon 2026-11-16) chosen by the season-first selector. Its simulated history starts
 * empty there, so the selector does not believe the November holiday topics were already
 * published by runs that actually happened under the old round-robin.
 */
export const SEASONAL_SELECTOR_GO_LIVE = new Date(Date.UTC(2026, 10, 16));
/**
 * A seasonal topic is not picked again within this many runs (26 weeks) — longer than any
 * season window, so each seasonal topic is published at most once per season, then comes back
 * the following year.
 */
export const SEASONAL_REPEAT_GAP_RUNS = 52;

/** Global run counter: 2 per week (Mon-Wed = even, Thu-Sun = odd), counted from {@link RUN_ORIGIN}. */
export function runIndexOf(date: Date): number {
  const day = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - RUN_ORIGIN.getTime()) / DAY_MS);
  return Math.floor(day / 7) * RUNS_PER_WEEK + runSlotOf(date);
}

/** Nominal cron date of run `r`: Monday (slot 0) or Thursday (slot 1) at 08:00 UTC. */
function runDate(r: number): Date {
  const week = Math.floor(r / RUNS_PER_WEEK);
  const slot = r - week * RUNS_PER_WEEK;
  return new Date(RUN_ORIGIN.getTime() + (week * 7 + (slot ? 3 : 0)) * DAY_MS + 8 * 3_600_000);
}

const NEVER = Number.MIN_SAFE_INTEGER;

/**
 * Pick the topic for run `run` on `date`, given when each topic was last picked.
 * 1. In-season SEASONAL topics not picked within {@link SEASONAL_REPEAT_GAP_RUNS}: least recently
 *    picked first, then topics that sell (have a collection), then the shortest window (expires
 *    soonest), then catalogue order.
 * 2. Otherwise an EVERGREEN topic: least recently picked, then topics with a collection, then
 *    catalogue order (a full rotation).
 * Never the previous run's topic, never an out-of-season one.
 */
function pickIndex(date: Date, run: number, last: Map<number, number>, prev: number | undefined): number {
  const lastOf = (i: number) => last.get(i) ?? NEVER;
  const sells = (i: number) => (BILINGUAL_TOPICS[i].collection ? 0 : 1);
  const byRecency = (a: number, b: number) =>
    lastOf(a) - lastOf(b) ||
    sells(a) - sells(b) ||
    WINDOW_DAYS[BILINGUAL_TOPICS[a].season] - WINDOW_DAYS[BILINGUAL_TOPICS[b].season] ||
    a - b;
  const ids = BILINGUAL_TOPICS.map((_, i) => i).filter((i) => i !== prev);
  const seasonal = ids.filter((i) => {
    const t = BILINGUAL_TOPICS[i];
    if (t.season === "all" || !isTopicInSeason(t, date)) return false;
    const l = last.get(i);
    return l === undefined || run - l > SEASONAL_REPEAT_GAP_RUNS;
  });
  if (seasonal.length > 0) return seasonal.sort(byRecency)[0];
  return ids.filter((i) => BILINGUAL_TOPICS[i].season === "all").sort(byRecency)[0];
}

/**
 * Pick the bilingual topic for the run containing `date`. FR and EN are read from the SAME
 * index, so the pair always shares a subject.
 *
 * Deterministic per run slot: the history of earlier runs is re-simulated from a fixed origin
 * ({@link SEASONAL_SELECTOR_GO_LIVE}, or {@link RUN_ORIGIN} for older dates) rather than read from
 * the database, so the same date always yields the same topic and the Mon/Thu runs of a week
 * always differ.
 */
export function selectBilingualTopic(date: Date): WeeklyTopicSelection {
  const run = runIndexOf(date);
  const goLive = runIndexOf(SEASONAL_SELECTOR_GO_LIVE);
  const start = run >= goLive ? goLive : run >= 0 ? 0 : run;
  const last = new Map<number, number>();
  let prev: number | undefined;
  for (let r = start; r < run; r++) {
    const i = pickIndex(runDate(r), r, last, prev);
    last.set(i, r);
    prev = i;
  }
  // The current run is judged on the ACTUAL date (a manual trigger on Wed Mar 2 must not pick a
  // February-only topic because the run's Monday was Feb 28).
  const idx = pickIndex(date, run, last, prev);
  const t = BILINGUAL_TOPICS[idx];
  return {
    idx,
    week: isoWeekNumber(date),
    slot: runSlotOf(date),
    run,
    fr: t.fr,
    en: t.en,
    imageQuery: t.imageQuery,
    season: t.season,
    ...(t.collection ? { collection: t.collection } : {}),
    ...(t.productTitlePattern ? { productTitlePattern: t.productTitlePattern } : {}),
    ...(t.relatedCollections ? { relatedCollections: t.relatedCollections } : {}),
    keywordsFr: extractKeywords(t.fr, "fr"),
    keywordsEn: extractKeywords(t.en, "en"),
  };
}
