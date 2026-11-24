/**
 * Brand-safety gate for "sujet chaud" posts — deterministic, runs AFTER the LLM's own judgement.
 *
 * Ameublo Direct is a furniture store: its Facebook page must never become a side of a political,
 * religious or tragic debate. The LLM is told the same rules, but a model can be talked into a
 * borderline topic by a catchy headline, so this list is the second, dumb, non-negotiable lock:
 * any hit on the topic, the card or the caption drops the candidate.
 *
 * Matching is accent- and case-insensitive on whole words. False positives are cheap (we lose one
 * candidate out of ~40 a day); a false negative is a brand incident. Keep the list conservative.
 */

/** Topic families a hot-topic post is allowed to be about. Anything else is dropped. */
export const ALLOWED_CATEGORIES = ["sport", "meteo", "culture", "fetes", "quotidien"] as const;
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

const BLOCKED_GROUPS: Record<string, string[]> = {
  politique: [
    "election", "elections", "elu", "elue", "depute", "deputes", "ministre", "ministres",
    "premier ministre", "gouvernement", "parlement", "assemblee nationale", "referendum",
    "souverainete", "independance du quebec", "caq", "pq", "plq", "ndp", "npd", "bloc quebecois",
    "conservateur", "conservateurs", "liberal", "liberaux", "legault", "trudeau", "carney",
    "poilievre", "plamondon", "trump", "biden", "harris", "macron", "poutine", "putin",
    "loi 21", "loi 96", "serment", "roi charles", "monarchie", "greve", "syndicat",
    "taxe carbone", "tarif", "tarifs", "douane", "douanes", "impot", "impots",
  ],
  religion: [
    "religion", "religieux", "islam", "islamique", "musulman", "musulmane", "juif", "juive",
    "judaisme", "chretien", "eglise", "pape", "mosquee", "synagogue", "voile", "hijab", "burqa",
    "laicite", "croyant", "athee",
  ],
  guerre_et_societe: [
    "guerre", "gaza", "israel", "palestine", "palestinien", "palestiniens", "hamas", "ukraine",
    "russie", "otan", "terroriste", "terrorisme", "attentat", "immigration", "immigrant",
    "immigrants", "migrant", "migrants", "refugie", "refugies", "racisme", "raciste",
    "avortement", "euthanasie", "lgbt", "lgbtq", "transgenre",
  ],
  tragedie: [
    "mort", "morte", "morts", "mourir", "meurt", "decede", "decedee", "deces", "deuil",
    "hommage", "funerailles", "obseques", "tue", "tuee", "tues", "meurtre", "homicide",
    "fusillade", "poignarde", "poignardee", "agression", "agressions", "viol", "sexuel",
    "sexuelle", "suicide", "noye", "noyade", "disparu", "disparue", "disparition", "enlevement",
    "accident", "collision", "carambolage", "incendie", "explosion", "ecrasement", "victime",
    "victimes", "blesse", "blesses", "blessee", "hospitalise", "hospitalisee", "urgence",
  ],
  sante: [
    "cancer", "covid", "pandemie", "virus", "vaccin", "vaccins", "maladie", "epidemie",
    "diagnostic", "chirurgie", "commotion", "depression", "burn out", "burnout",
  ],
  justice: [
    "proces", "tribunal", "accuse", "accusee", "accuses", "accusation", "accusations",
    "arrestation", "enquete", "police", "poursuite", "condamne",
    "condamnee", "prison", "scandale", "fraude", "plainte", "plaintes", "allegation",
    "allegations", "mise en accusation", "suspendu pour",
  ],
  argent_sensible: [
    "faillite", "mises a pied", "mise a pied", "licenciement", "licenciements", "rappel de produit",
    "intoxication", "salmonelle", "listeria",
  ],
};

interface CompiledGroup { group: string; entries: Array<{ word: string; re: RegExp }> }

const COMPILED: CompiledGroup[] = Object.entries(BLOCKED_GROUPS).map(([group, words]) => ({
  group,
  // Whole-word / whole-phrase match on the normalised text (single spaces between tokens).
  entries: words.map((word) => ({ word, re: new RegExp(`(?:^| )${word}(?: |$)`) })),
}));

export interface SafetyVerdict {
  safe: boolean;
  /** Blocked group (e.g. "politique") when unsafe, for the audit trail. */
  group?: string;
  /** The word/phrase that matched. */
  match?: string;
}

/** Check one or more strings; the first hit wins. */
export function checkBrandSafety(...texts: Array<string | null | undefined>): SafetyVerdict {
  for (const raw of texts) {
    if (!raw) continue;
    const norm = normalizeForSafety(raw);
    for (const { group, entries } of COMPILED) {
      for (const { word, re } of entries) {
        if (re.test(norm)) return { safe: false, group, match: word };
      }
    }
  }
  return { safe: true };
}
