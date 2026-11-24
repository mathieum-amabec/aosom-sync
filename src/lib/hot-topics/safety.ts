/**
 * Brand-safety gate for "sujet chaud" posts — deterministic, runs AFTER the LLM's own judgement.
 *
 * Ameublo Direct is a furniture store: its Facebook page must never become a side of a political,
 * religious or tragic debate. The LLM is told the same rules, but a model can be talked into a
 * borderline topic by a catchy headline, so these lists are the second, dumb, non-negotiable lock.
 *
 * Two tiers:
 *  - HARD: any hit on a topic, a card or a caption drops the candidate / proposal. No appeal.
 *  - SOFT ("à vérifier"): words that are fine in a hockey headline but dangerous in a post that
 *    names a person (blessure, suspension, rumeur…). The headline may still inspire a post, but
 *    (1) the post itself may never contain them and (2) the draft is flagged for the approver and
 *    never chosen over an unflagged one.
 *
 * Matching is accent- and case-insensitive on whole words; single words also match their plural /
 * feminine forms (+s, +e, +es). False positives are cheap (we lose one candidate out of ~40 a day);
 * a false negative is a brand incident. Keep the list conservative.
 */

/** Topic families a hot-topic post is allowed to be about. Anything else is dropped. */
export const ALLOWED_CATEGORIES = ["sport", "meteo", "culture", "fetes", "quotidien", "maison"] as const;
export type HotTopicCategory = (typeof ALLOWED_CATEGORIES)[number];

/** Lower-case, strip accents, collapse punctuation to spaces — the form the patterns run on. */
export function normalizeForSafety(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Harmless idioms that contain a blocked word — removed before matching. */
const IDIOMS = ["mort de rire", "mort subite", "morte de rire", "mort de fatigue"];

const BLOCKED_GROUPS: Record<string, string[]> = {
  politique: [
    "election", "elu", "depute", "ministre", "premier ministre", "gouvernement", "parlement",
    "assemblee nationale", "referendum", "souverainete", "independance du quebec", "caq", "pq",
    "plq", "ndp", "npd", "bloc quebecois", "conservateur", "liberal", "liberaux", "legault", "trudeau",
    "carney", "poilievre", "plamondon", "trump", "biden", "harris", "macron", "poutine", "putin",
    "loi 21", "loi 96", "serment", "roi charles", "monarchie", "greve", "syndicat", "taxe carbone",
    "tarif", "douane", "impot", "maire", "mairesse", "election municipale", "sondage electoral",
    "autochtone", "premieres nations", "pipeline", "petrole", "colonisation",
  ],
  religion: [
    "religion", "religieux", "islam", "islamique", "musulman", "juif", "judaisme", "chretien",
    "eglise", "pape", "mosquee", "synagogue", "voile", "hijab", "burqa", "laicite", "croyant",
    "athee", "secte",
  ],
  guerre_et_societe: [
    "guerre", "gaza", "israel", "palestine", "palestinien", "hamas", "ukraine", "russie", "otan",
    "terroriste", "terrorisme", "attentat", "immigration", "immigrant", "migrant", "refugie",
    "racisme", "raciste", "avortement", "euthanasie", "lgbt", "lgbtq", "transgenre", "genocide",
    "nazi", "holocauste", "armee", "bombardement", "otage", "itinerance", "sans abri",
    "prostitution", "trafic humain",
  ],
  tragedie: [
    "mort", "mourir", "meurt", "decede", "deces", "deuil", "hommage", "funerailles", "obseques",
    "tue", "meurtre", "homicide", "fusillade", "poignarde", "agression", "viol", "sexuel",
    "suicide", "noye", "noyade", "disparu", "disparition", "enlevement", "kidnapping", "accident",
    "collision", "carambolage", "incendie", "explosion", "ecrasement", "victime", "hospitalise",
    "surdose", "overdose", "fentanyl", "drogue", "cocaine", "arme", "fusil", "coup de feu",
    "harcelement", "pedophile", "pedophilie", "pornographie",
  ],
  sante: [
    "cancer", "covid", "pandemie", "virus", "vaccin", "maladie", "epidemie", "diagnostic",
    "chirurgie", "commotion", "depression", "burn out", "burnout", "dopage", "dope", "greffe",
  ],
  justice: [
    "proces", "tribunal", "accuse", "accusation", "arrestation", "enquete", "police", "poursuite",
    "condamne", "prison", "scandale", "fraude", "plainte", "allegation", "mise en accusation",
    "suspendu pour", "poursuivi", "cour supreme", "inculpe", "coupable",
  ],
  vulgarite: [
    "con", "cons", "conne", "connard", "merde", "putain", "salope", "tabarnak", "calisse", "criss", "ostie", "fuck",
    "shit", "bitch", "osti", "esti",
  ],
  argent_sensible: [
    "faillite", "mises a pied", "mise a pied", "licenciement", "rappel de produit", "intoxication",
    "salmonelle", "listeria",
  ],
};

/**
 * Words that are normal in a sports headline but unsafe in a post about a named person.
 * A source headline may contain them (the draft is then flagged); the post never may.
 */
const SOFT_WORDS: string[] = [
  "blesse", "blessure", "blessures", "suspendu", "suspension", "rumeur", "rumeurs", "bagarre",
  "urgence", "limoge", "congedie", "renvoye", "sanction", "amende", "conflit",
];

/** Words whose +s/+e forms are different, harmless words ("con" → "cone"): matched exactly. */
const EXACT_ONLY = new Set(["con", "cons"]);

interface CompiledEntry { word: string; re: RegExp }
interface CompiledGroup { group: string; entries: CompiledEntry[] }

function compile(word: string): CompiledEntry {
  // Single words also match +s / +e / +es; phrases match as written. Whole-word on normalised text.
  const suffix = word.includes(" ") || EXACT_ONLY.has(word) ? "" : "(?:s|e|es)?";
  return { word, re: new RegExp(`(?:^| )${word}${suffix}(?: |$)`) };
}

const COMPILED: CompiledGroup[] = Object.entries(BLOCKED_GROUPS).map(([group, words]) => ({
  group,
  entries: words.map(compile),
}));
const COMPILED_SOFT: CompiledEntry[] = SOFT_WORDS.map(compile);

export interface SafetyVerdict {
  safe: boolean;
  /** Blocked group (e.g. "politique") when unsafe, for the audit trail. */
  group?: string;
  /** The word/phrase that matched. */
  match?: string;
  /** Soft ("à vérifier") words found; only meaningful when `safe` is true. */
  soft?: string[];
}

function normalizeText(raw: string): string {
  let norm = normalizeForSafety(raw);
  for (const idiom of IDIOMS) norm = norm.replace(new RegExp(`(?:^| )${idiom}(?= |$)`, "g"), " ");
  return norm.trim();
}

/** Soft-tier words present in the given texts (de-duplicated). */
export function softHits(...texts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const raw of texts) {
    if (!raw) continue;
    const norm = normalizeText(raw);
    for (const { word, re } of COMPILED_SOFT) if (re.test(norm)) found.add(word);
  }
  return [...found];
}

/** Hard check on one or more strings; the first hit wins. When safe, also reports soft words. */
export function checkBrandSafety(...texts: Array<string | null | undefined>): SafetyVerdict {
  for (const raw of texts) {
    if (!raw) continue;
    const norm = normalizeText(raw);
    for (const { group, entries } of COMPILED) {
      for (const { word, re } of entries) {
        if (re.test(norm)) return { safe: false, group, match: word };
      }
    }
  }
  return { safe: true, soft: softHits(...texts) };
}
