/**
 * Calendar bank: posts that are known weeks in advance (pneus d'hiver le 1er décembre, Vendredi fou,
 * sapin de Noël, 1er juillet…). The review found ~70 % of the best topics are predictable, and a
 * dated fact is the one thing that can never be wrong or off-brand — so these posts are written
 * once, here, and need no LLM and no feed.
 *
 * Every text is plain tutoiement, a real question, and a neutral "fact line" (a date, or the
 * recognised framing of a classic debate) that gives people the context at a glance. A unit test
 * runs every entry, for every day of its window and for several years, through the same validator
 * as the LLM posts.
 */
import type { HotTopicCategory } from "./safety";

export interface CalendarPost {
  id: string;
  category: HotTopicCategory;
  /** Card block 1: what this is about, with the date. */
  factLine: string;
  /** Card block 2: the question. */
  question: string;
  /** Facebook caption (ends with a question). */
  caption: string;
  /** Days until the target date (negative = already passed). */
  days: number;
  /** Unix seconds after which the post is stale and must not be published. */
  expiresAt: number;
  /** How a human can verify the fact. */
  sourceNote: string;
}

interface Built { factLine: string; question: string; caption: string }

interface CalendarEntry {
  id: string;
  category: HotTopicCategory;
  /** The target day for a calendar year (month 1–12). */
  target: (year: number) => { m: number; d: number };
  /** Active from this many days before the target… */
  leadDays: number;
  /** …until this many days after it. */
  afterDays: number;
  build: (days: number, target: { m: number; d: number }, year: number) => Built;
  sourceNote: string;
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function frDate(m: number, d: number): string {
  return `${d === 1 ? "1er" : d} ${MONTHS[m - 1]}`;
}

function inDays(days: number): string {
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return "demain";
  return `dans ${days} jours`;
}

/** Day-of-month of the nth (1-based) given weekday (0 = Sunday) of a month. */
export function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** The Friday after the 4th Thursday of November. */
export function blackFridayDay(year: number): number {
  return nthWeekday(year, 11, 4, 4) + 1;
}

const ENTRIES: CalendarEntry[] = [
  {
    id: "pneus-hiver", category: "quotidien", target: () => ({ m: 12, d: 1 }), leadDays: 10, afterDays: 3,
    sourceNote: "SAAQ: pneus d'hiver obligatoires du 1er décembre au 15 mars.",
    build: (days) => ({
      factLine: days > 0
        ? `Les pneus d'hiver sont obligatoires au Québec dès le 1er décembre, ${inDays(days)}.`
        : "Les pneus d'hiver sont obligatoires au Québec depuis le 1er décembre.",
      question: "Tes pneus d'hiver sont déjà posés ou tu attends la première bordée?",
      caption: "Les pneus d'hiver sont obligatoires du 1er décembre au 15 mars. Les tiens sont déjà posés, ou tu attends à la dernière minute? 🚗",
    }),
  },
  {
    id: "vendredi-fou", category: "fetes", target: (y) => ({ m: 11, d: blackFridayDay(y) }), leadDays: 6, afterDays: 1,
    sourceNote: "Vendredi fou = le vendredi après la 4e jeudi de novembre.",
    build: (days, t) => ({
      factLine: days > 0 ? `Le Vendredi fou, c'est le ${frDate(t.m, t.d)}, ${inDays(days)}.` : "C'est le Vendredi fou.",
      question: "Vendredi fou: tu magasines en ligne ou tu y vas en personne?",
      caption: `Le Vendredi fou est ${days > 0 ? `le ${frDate(t.m, t.d)}` : "aujourd'hui"}. Tu es plutôt magasinage en ligne dans le confort de ton salon, ou foule en magasin? 🛍️`,
    }),
  },
  {
    id: "sapin-noel", category: "maison", target: () => ({ m: 12, d: 25 }), leadDays: 31, afterDays: 0,
    sourceNote: "Noël = 25 décembre.",
    build: (days) => ({
      factLine: `Noël, c'est le 25 décembre, ${inDays(days)}.`,
      question: "Sapin naturel ou sapin artificiel: tu es dans quelle équipe?",
      caption: "À l'approche de Noël, un grand classique: sapin naturel qui sent bon, ou sapin artificiel qu'on ressort chaque année? 🎄",
    }),
  },
  {
    id: "reveillon", category: "fetes", target: () => ({ m: 12, d: 24 }), leadDays: 5, afterDays: 0,
    sourceNote: "Réveillon de Noël = 24 décembre.",
    build: (days) => ({
      factLine: `Le réveillon de Noël, c'est le 24 décembre, ${inDays(days)}.`,
      question: "Tu ouvres tes cadeaux le 24 au soir ou le matin du 25?",
      caption: "Au Québec, le réveillon fait partie des traditions. Cadeaux ouverts le 24 au soir, ou tu attends le matin de Noël? 🎁",
    }),
  },
  {
    id: "boxing-day", category: "fetes", target: () => ({ m: 12, d: 26 }), leadDays: 4, afterDays: 0,
    sourceNote: "Boxing Day = 26 décembre.",
    build: (days) => ({
      factLine: `Le Boxing Day, c'est le 26 décembre, ${inDays(days)}.`,
      question: "Boxing Day: tu fais les magasins ou tu restes sous la couverte?",
      caption: "Le lendemain de Noël, certains courent les aubaines et d'autres ne bougent pas du sofa. Toi, tu es dans quel clan? 🛋️",
    }),
  },
  {
    id: "jour-de-lan", category: "fetes", target: () => ({ m: 1, d: 1 }), leadDays: 5, afterDays: 0,
    sourceNote: "Jour de l'An = 1er janvier.",
    build: (days, _t, year) => ({
      factLine: `Le Jour de l'An, c'est le 1er janvier, ${inDays(days)}.`,
      question: "Résolutions du Nouvel An: tu en prends une ou tu laisses faire?",
      caption: `Nouvelle année, nouvelles résolutions? Tu t'en fixes une pour ${year}, ou tu trouves que c'est une cause perdue d'avance? 🥂`,
    }),
  },
  {
    id: "saint-valentin", category: "fetes", target: () => ({ m: 2, d: 14 }), leadDays: 9, afterDays: 0,
    sourceNote: "Saint-Valentin = 14 février.",
    build: (days) => ({
      factLine: `La Saint-Valentin, c'est le 14 février, ${inDays(days)}.`,
      question: "Saint-Valentin: grosse soirée ou journée comme les autres?",
      caption: "Souper au restaurant, petit cadeau, ou tu fais comme si de rien n'était? Ta Saint-Valentin ressemble à quoi? ❤️",
    }),
  },
  {
    id: "heure-ete", category: "quotidien", target: (y) => ({ m: 3, d: nthWeekday(y, 3, 0, 2) }), leadDays: 6, afterDays: 1,
    sourceNote: "Heure d'été: 2e dimanche de mars, on avance l'heure d'une heure.",
    build: (days, t) => ({
      factLine: days > 0 ? `On avance l'heure d'une heure dimanche, le ${frDate(t.m, t.d)}.` : "On a avancé l'heure d'une heure ce week-end.",
      question: "Changer l'heure deux fois par année: tu aimes ça ou tu en as assez?",
      caption: "Une heure de sommeil en moins, mais plus de lumière le soir. Tu trouves que ça vaut le coup, ou tu aimerais qu'on arrête de changer l'heure? ⏰",
    }),
  },
  {
    id: "heure-hiver", category: "quotidien", target: (y) => ({ m: 11, d: nthWeekday(y, 11, 0, 1) }), leadDays: 6, afterDays: 1,
    sourceNote: "Heure d'hiver: 1er dimanche de novembre, on recule l'heure d'une heure.",
    build: (days, t) => ({
      factLine: days > 0 ? `On recule l'heure d'une heure dimanche, le ${frDate(t.m, t.d)}.` : "On a reculé l'heure d'une heure ce week-end.",
      question: "Une heure de plus de sommeil ou le soir qui tombe trop tôt: ton avis?",
      caption: "On gagne une heure de sommeil, mais il fait noir à 16 h 30. Ça te dérange ou tu es content de dormir plus? ⏰",
    }),
  },
  {
    id: "poisson-avril", category: "fetes", target: () => ({ m: 4, d: 1 }), leadDays: 3, afterDays: 0,
    sourceNote: "Poisson d'avril = 1er avril.",
    build: (days) => ({
      factLine: `Le poisson d'avril, c'est le 1er avril, ${inDays(days)}.`,
      question: "Poisson d'avril: tu fais des blagues ou tu te méfies de tout le monde ce jour-là?",
      caption: "Le 1er avril, on se méfie de tout. Tu es plutôt celui qui prépare une blague ou celui qui se fait avoir? 🐟",
    }),
  },
  {
    id: "fete-des-meres", category: "fetes", target: (y) => ({ m: 5, d: nthWeekday(y, 5, 0, 2) }), leadDays: 9, afterDays: 0,
    sourceNote: "Fête des mères = 2e dimanche de mai.",
    build: (days, t) => ({
      factLine: `La fête des mères, c'est le dimanche ${frDate(t.m, t.d)}, ${inDays(days)}.`,
      question: "Fête des mères: ton cadeau est déjà acheté ou tu es dans la dernière minute?",
      caption: "Fleurs, resto, petit cadeau… Pour la fête des mères, tu es du genre organisé ou tu y penses la veille? 💐",
    }),
  },
  {
    id: "fete-des-peres", category: "fetes", target: (y) => ({ m: 6, d: nthWeekday(y, 6, 0, 3) }), leadDays: 9, afterDays: 0,
    sourceNote: "Fête des pères = 3e dimanche de juin.",
    build: (days, t) => ({
      factLine: `La fête des pères, c'est le dimanche ${frDate(t.m, t.d)}, ${inDays(days)}.`,
      question: "Fête des pères: cadeau utile ou cadeau-surprise?",
      caption: "Un outil pratique ou un cadeau complètement inattendu? Pour la fête des pères, tu pars sur quoi? 🎁",
    }),
  },
  {
    id: "demenagement", category: "maison", target: () => ({ m: 7, d: 1 }), leadDays: 30, afterDays: 0,
    sourceNote: "Au Québec, la majorité des baux se terminent le 30 juin; le 1er juillet est le jour de déménagement.",
    build: (days) => ({
      factLine: `Le 1er juillet, c'est le grand jour du déménagement au Québec, ${inDays(days)}.`,
      question: "Déménager le 1er juillet: tu l'as déjà vécu ou tu l'évites à tout prix?",
      caption: "Camion réservé, boîtes partout et tout le monde dans les rues le même jour. Le 1er juillet, tu en gardes de bons souvenirs ou des cauchemars? 📦",
    }),
  },
  {
    id: "halloween", category: "fetes", target: () => ({ m: 10, d: 31 }), leadDays: 14, afterDays: 0,
    sourceNote: "Halloween = 31 octobre.",
    build: (days) => ({
      factLine: `L'Halloween, c'est le 31 octobre, ${inDays(days)}.`,
      question: "Halloween: tu donnes des bonbons ou tu éteins les lumières?",
      caption: "Le 31 octobre, certains décorent toute la maison et d'autres font semblant de ne pas être là. Toi, c'est lequel? 🎃",
    }),
  },
  // Evergreen winter debate — the only entries without a hard date: they say so in their fact line.
  {
    id: "thermostat-hiver", category: "maison", target: () => ({ m: 12, d: 5 }), leadDays: 0, afterDays: 80,
    sourceNote: "Débat de saison, aucune donnée affirmée.",
    build: () => ({
      factLine: "Le grand débat de l'hiver: la température du thermostat.",
      question: "L'hiver, tu laisses ton thermostat à 19, 21 ou 23 degrés?",
      caption: "Pull et chaussettes de laine, ou chauffage à fond? À quelle température tu règles ton thermostat l'hiver? 🌡️",
    }),
  },
];

/** Toronto calendar date of an instant as a UTC-midnight day number. */
function torontoDayNumber(now: Date): { day: number; year: number } {
  const [y, m, d] = now.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }).split("-").map(Number);
  return { day: Math.floor(Date.UTC(y, m - 1, d) / 86400000), year: y };
}

/** Every calendar post active on `now`, most urgent (closest upcoming date) first. */
export function calendarPosts(now: Date = new Date()): CalendarPost[] {
  const { day: today, year } = torontoDayNumber(now);
  const out: CalendarPost[] = [];
  for (const e of ENTRIES) {
    for (const y of [year - 1, year, year + 1]) {
      const t = e.target(y);
      const targetDay = Math.floor(Date.UTC(y, t.m - 1, t.d) / 86400000);
      const days = targetDay - today;
      if (days > e.leadDays || days < -e.afterDays) continue;
      const built = e.build(days, t, y);
      out.push({
        id: e.id, category: e.category, ...built, days,
        // End of the last active day (Toronto ≈ UTC-5) — never publish a countdown after it.
        expiresAt: (targetDay + e.afterDays + 1) * 86400 + 5 * 3600,
        sourceNote: e.sourceNote,
      });
      break;
    }
  }
  // Upcoming dates first (smallest non-negative days), then dates just passed.
  out.sort((a, b) => (a.days < 0 ? 1000 - a.days : a.days) - (b.days < 0 ? 1000 - b.days : b.days));
  return out;
}

/** For tests: every entry id. */
export const CALENDAR_IDS = ENTRIES.map((e) => e.id);
/** For tests: build every entry for a given day offset, ignoring the active window. */
export function buildAllEntries(year: number, days: number): Array<{ id: string } & Built & { category: HotTopicCategory }> {
  return ENTRIES.map((e) => ({ id: e.id, category: e.category, ...e.build(days, e.target(year), year) }));
}
