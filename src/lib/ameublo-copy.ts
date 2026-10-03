/**
 * What Ameublo says in the video styles — hand-written, Hormozi-style, free (no AI call).
 *
 * Mat (2026-10-03): "une variété du texte… un peu de clickbait, vente à la Alex Hormozi".
 * Every video gets a hook (curiosity / pain), a value line for its product family, a price
 * teaser and a call to action. Picks are deterministic per SKU, so a re-render reproduces
 * the same video, and `variant` lets a series walk through different combinations.
 *
 * Honest clickbait only: curiosity and reactions, never a claim we can't back (no "le moins
 * cher", no fake stock or countdown, no invented discount).
 */

export type ProductFamily =
  | "rangement" | "salon" | "bureau" | "enfants" | "animaux" | "chambre" | "noel" | "cuisine" | "general";

const FAMILY_RULES: [ProductFamily, RegExp][] = [
  ["noel", /christmas|sapin|noël|xmas/i],
  ["animaux", /\b(dog|cat|pet)s?\b|chien|chat|animal/i],
  ["enfants", /kids|enfant|toddler|toy|jouet|ride-on/i],
  ["bureau", /office|desk|bureau/i],
  ["salon", /sofa|loveseat|canap|couch|coffee table|table basse|table à café|tv stand|accent chair|fauteuil/i],
  ["chambre", /bedroom|nightstand|vanity|coiffeuse|mirror|miroir|chevet/i],
  ["rangement", /storage|cabinet|sideboard|buffet|pantry|armoire|shoe|bookcase|bibliothèque|rangement|ottoman/i],
  ["cuisine", /kitchen|dining|bar stool|tabouret|cuisine|salle à manger/i],
];

export function productFamily(text: string): ProductFamily {
  return FAMILY_RULES.find(([, re]) => re.test(text))?.[0] ?? "general";
}

/** Opening hooks — curiosity, the reason to keep watching. */
export const HOOKS = [
  "ATTENDS DE VOIR LE PRIX",
  "ARRÊTE DE SCROLLER",
  "REGARDE JUSQU’À LA FIN",
  "PERSONNE NE M’A DIT ÇA",
  "TU VAS VOULOIR ÇA",
  "OK… JE SUIS JALOUX",
  "JE N’Y CROYAIS PAS",
  "C’EST MOI OU C’EST GÉNIAL ?",
  "MON NOUVEAU COUP DE CŒUR",
  "TU CHERCHAIS ÇA ?",
] as const;

/** Value lines per family — the desire, in Ameublo's voice. */
export const VALUE: Record<ProductFamily, string[]> = {
  rangement: ["FINI LE DÉSORDRE", "TOUT A ENFIN SA PLACE", "ADIEU LE FOUILLIS"],
  salon: ["TON SALON, VERSION DESIGN", "LE SALON QUE TU MÉRITES", "TES INVITÉS VONT CAPOTER"],
  bureau: ["ADIEU LA TABLE DE CUISINE", "TON BUREAU, VERSION PRO", "TRAVAILLER, MAIS EN BEAU"],
  enfants: ["ILS VONT CAPOTER", "LEUR NOUVEAU PRÉFÉRÉ", "LA SURPRISE DE L’ANNÉE"],
  animaux: ["TON ANIMAL VA T’ADORER", "IL MÉRITE ÇA", "SON COIN À LUI"],
  chambre: ["TA CHAMBRE, VERSION HÔTEL", "LE MATIN VA CHANGER", "UN COIN JUSTE POUR TOI"],
  noel: ["NOËL COMMENCE ICI", "LE SALON DES FÊTES", "LA MAGIE, SANS EFFORT"],
  cuisine: ["TA CUISINE, VERSION CAFÉ", "LES SOUPERS VONT CHANGER", "TOUT LE MONDE À TABLE"],
  general: ["ÇA CHANGE TOUT", "J’EN VEUX UN", "SIMPLE ET BEAU"],
};

/** Price teasers — the beat just before the price lands. */
export const TEASERS = ["ET LE PRIX ?", "DEVINE LE PRIX…", "T’ES PRÊT ?", "ACCROCHE-TOI…"] as const;

/** Closing calls to action. */
export const CTAS = ["COURS VOIR ÇA", "VA VOIR ÇA", "CLIQUE, TU VAS VOIR", "MAGASINE-LE ICI"] as const;

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}
const pick = <T>(list: readonly T[], seed: number): T => list[seed % list.length];

export interface AmeubloLines {
  hook: string;
  value: string;
  teaser: string;
  cta: string;
}

/**
 * The four lines for one video. `variant` shifts every pick, so the n-th video of a series
 * never reuses the (n-1)-th one's hook.
 */
export function ameubloLines(sku: string, familyText: string, variant = 0): AmeubloLines {
  const h = hash(sku);
  const fam = productFamily(familyText);
  return {
    hook: pick(HOOKS, h + variant),
    value: pick(VALUE[fam], (h >>> 3) + variant),
    teaser: pick(TEASERS, (h >>> 6) + variant),
    cta: pick(CTAS, (h >>> 9) + variant),
  };
}
