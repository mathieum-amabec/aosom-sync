/**
 * Category / sub-category of a Studio Ameublo video, derived from what is on screen (the catalogue
 * product types of its SKUs), never from the `campaign` tag: 417 of 493 videos carry "maison-2026"
 * even when they show a cat tree or a pumpkin ghost.
 */

export type CategoryKey =
  | "halloween"
  | "animaux"
  | "salon"
  | "cuisine"
  | "chambre"
  | "bureau"
  | "rangement"
  | "salle-de-bain"
  | "decoration"
  | "enfants"
  | "autres";

export const CATEGORY_LABEL: Record<CategoryKey, string> = {
  halloween: "Halloween",
  animaux: "Animaux",
  salon: "Salon",
  cuisine: "Cuisine et salle à manger",
  chambre: "Chambre",
  bureau: "Bureau",
  rangement: "Rangement",
  "salle-de-bain": "Salle de bain",
  decoration: "Décoration",
  enfants: "Enfants",
  autres: "Autres",
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL) as CategoryKey[];

const CATEGORY_RULES: [CategoryKey, RegExp][] = [
  ["halloween", /Halloween/i],
  ["animaux", /^Pet Supplies/i],
  ["salon", /Living Room Furniture/i],
  ["cuisine", /Kitchen & Dining Furniture/i],
  ["chambre", /Bedroom Furniture/i],
  ["bureau", /^Office Products/i],
  ["rangement", /Storage & Organization/i],
  ["salle-de-bain", /Bathroom Furniture/i],
  ["decoration", /Home Décor|Home Decor/i],
  ["enfants", /Toys & Games|Baby/i],
];

const SUB_RULES: Partial<Record<CategoryKey, [string, RegExp][]>> = {
  animaux: [
    ["Chats", /\bCat/i],
    ["Chiens", /\bDog/i],
  ],
  salon: [
    ["Canapés et fauteuils", /Sofa|Couch|Chair/i],
    ["Tables", /Table/i],
    ["Meubles TV", /TV Stand/i],
  ],
  cuisine: [
    ["Tabourets de bar", /Bar Stool/i],
    ["Chaises de salle à manger", /Dining Chair/i],
    ["Tables", /Dining Table|Bar Table|Table Set/i],
    ["Bars et ensembles de bar", /Bar Cabinet|Bar Set/i],
    ["Îlots et chariots", /Island|Cart/i],
    ["Garde-manger", /Pantry/i],
  ],
  chambre: [
    ["Tables de chevet", /Bedside/i],
    ["Coiffeuses", /Dressing|Vanity/i],
    ["Miroirs", /Mirror/i],
    ["Lits", /Bed Frame/i],
  ],
  bureau: [
    ["Chaises de bureau", /Chair/i],
    ["Bureaux", /Desk/i],
    ["Rangement de bureau", /Cabinet|Cupboard/i],
  ],
  rangement: [
    ["Armoires de rangement", /Storage Cabinets/i],
    ["Garde-manger", /Pantry/i],
    ["Meubles à chaussures", /Shoe/i],
    ["Bancs et ottomans", /Ottoman|Bench/i],
    ["Bibliothèques", /Bookshel|Bookcase/i],
  ],
  "salle-de-bain": [
    ["Armoires de salle de bain", /Cabinet/i],
    ["Chaises de bain", /Bath Chair/i],
  ],
  decoration: [
    ["Tapis", /Rug/i],
    ["Luminaires", /Lamp|Light/i],
  ],
};

/** Halloween decor shares one catalogue type, so its sub-category comes from the on-screen title (FR or EN). */
const HALLOWEEN_SUB: [string, RegExp][] = [
  ["Gonflables", /gonflable|inflatable|airblown|blow[- ]?up/i],
  ["Suspendus", /suspendu|hanging/i],
  ["Animés", /animé|animated|animatronic/i],
];
export const HALLOWEEN_SUB_OTHER = "Autres décors";
export const SUB_OTHER = "Autres";

export interface VideoCategory {
  category: CategoryKey;
  sub: string;
}

function mostCommon<T>(xs: T[]): T | null {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [x, c] of n) if (c > bestN) [best, bestN] = [x, c];
  return best;
}

const CAMPAIGN_FALLBACK: [RegExp, CategoryKey][] = [
  [/^halloween/i, "halloween"],
  [/^animaux/i, "animaux"],
  [/^enfants/i, "enfants"],
];

export function categoryOfType(productType: string): CategoryKey | null {
  for (const [key, re] of CATEGORY_RULES) if (re.test(productType)) return key;
  return null;
}

/**
 * `productTypes`: catalogue product_type of each SKU on screen. `label`: the on-screen titles joined by " vs "
 * (used only to split Halloween decor). `campaign`: last-resort hint when no product type is known.
 * A video showing several products takes its most common category, then its most common sub-category.
 */
export function categorize(a: { productTypes: string[]; label?: string | null; campaign?: string | null }): VideoCategory {
  const cats = a.productTypes.map(categoryOfType).filter((c): c is CategoryKey => c != null);
  let category = mostCommon(cats);
  if (!category) {
    const hint = CAMPAIGN_FALLBACK.find(([re]) => re.test(a.campaign ?? ""));
    category = hint ? hint[1] : "autres";
  }

  if (category === "halloween") {
    const parts = (a.label ?? "").split(/\s+vs\s+/i).filter(Boolean);
    const subs = parts.map((p) => HALLOWEEN_SUB.find(([, re]) => re.test(p))?.[0] ?? HALLOWEEN_SUB_OTHER);
    return { category, sub: mostCommon(subs) ?? HALLOWEEN_SUB_OTHER };
  }

  const rules = SUB_RULES[category] ?? [];
  const subs = a.productTypes
    .filter((t) => categoryOfType(t) === category)
    .map((t) => rules.find(([, re]) => re.test(t))?.[0] ?? SUB_OTHER);
  return { category, sub: mostCommon(subs) ?? SUB_OTHER };
}
