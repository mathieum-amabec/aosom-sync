/**
 * Hook Selector — picks a hook from the pool for a given product and language.
 *
 * Strategy:
 * - Map product_type → one of 8 scopes (outdoor_patio, storage_kitchen,
 *   mobilier_indoor, pets, kids_toys_sport, bedroom_decor, seasonal_decor,
 *   universal). home_office is merged into mobilier_indoor.
 * - Exclude the last 5 used categories (anti-repeat rotation).
 *   If no hooks survive exclusion, retry without exclusion.
 * - 60% pool (hook text verbatim as post opener), 40% generative_seeded.
 * - From the top-10 least-used compatible hooks, pick one at random.
 */

import {
  getRecentHookCategoryIds,
  selectCompatibleHooks,
  recordHookUsage,
  type ContentHook,
} from "@/lib/database";

export type ProductScope =
  | "outdoor_patio"
  | "storage_kitchen"
  | "mobilier_indoor"
  | "pets"
  | "kids_toys_sport"
  | "bedroom_decor"
  | "seasonal_decor"
  | "universal";

export interface HookSelection {
  hookId: number;
  text: string;
  mode: "pool" | "generative_seeded";
  scope: ProductScope;
}

// ─── Product Type → Scope Mapping ────────────────────────────────────
// Rules are matched in order — longest/most-specific prefix first.

const SCOPE_RULES: Array<{ prefix: string; scope: ProductScope }> = [
  // Pet Supplies
  { prefix: "Pet Supplies", scope: "pets" },

  // Kids Toys & Sports
  { prefix: "Toys & Games", scope: "kids_toys_sport" },
  { prefix: "Sports & Recreation", scope: "kids_toys_sport" },

  // Outdoor & Patio
  { prefix: "Patio & Garden", scope: "outdoor_patio" },
  { prefix: "Patio, Lawn & Garden", scope: "outdoor_patio" },
  { prefix: "Garden", scope: "outdoor_patio" },
  { prefix: "Outdoor", scope: "outdoor_patio" },

  // Bedroom & Decor — sub-paths before parent catch-all
  { prefix: "Home Furnishings > Bedroom", scope: "bedroom_decor" },
  { prefix: "Bedding & Bath", scope: "bedroom_decor" },
  { prefix: "Home Décor", scope: "bedroom_decor" },
  { prefix: "Home Decor", scope: "bedroom_decor" },
  { prefix: "Holiday", scope: "bedroom_decor" },

  // Seasonal decorations (Halloween, Christmas trees, holiday décor) — was falling
  // through to the "Home Furnishings" catch-all below (mobilier_indoor), which fed
  // furniture-shopping hooks ("this bedroom collection...") onto e.g. a Halloween
  // inflatable cat. Also covers non-holiday home décor (artificial trees,
  // fireplaces) that isn't bedroom-specific either. Must stay ABOVE the generic
  // "Home Furnishings" rule, since the real Aosom/Shopify taxonomy always prefixes
  // these with "Home Furnishings > ", not the bare "Holiday"/"Home Décor" above.
  { prefix: "Home Furnishings > Holiday & Seasonal", scope: "seasonal_decor" },
  { prefix: "Home Furnishings > Home Décor", scope: "seasonal_decor" },
  { prefix: "Home Furnishings > Home Decor", scope: "seasonal_decor" },

  // Storage & Kitchen — sub-paths before parent catch-all
  { prefix: "Home Furnishings > Storage", scope: "storage_kitchen" },
  { prefix: "Home Furnishings > Kitchen", scope: "storage_kitchen" },
  // Real taxonomy prefixes these "Home Furnishings > Appliances" / "> Bathroom
  // Furniture" — the bare "Appliances" rule below never matched them, so they also
  // fell through to mobilier_indoor.
  { prefix: "Home Furnishings > Appliances", scope: "storage_kitchen" },
  { prefix: "Home Furnishings > Bathroom", scope: "storage_kitchen" },
  { prefix: "Appliances", scope: "storage_kitchen" },

  // Mobilier intérieur — home_office merged here, catch-all last
  { prefix: "Home Furnishings > Living Room", scope: "mobilier_indoor" },
  { prefix: "Home Furnishings > Dining", scope: "mobilier_indoor" },
  { prefix: "Home Furnishings > Office", scope: "mobilier_indoor" },
  { prefix: "Home Furnishings", scope: "mobilier_indoor" },
  { prefix: "Office Products", scope: "mobilier_indoor" },
  { prefix: "Furniture", scope: "mobilier_indoor" },
  { prefix: "Living", scope: "mobilier_indoor" },
  { prefix: "Dining", scope: "mobilier_indoor" },
];

export function mapProductTypeToScope(productType: string | null | undefined): ProductScope {
  if (!productType || productType.trim().length === 0) return "universal";
  const normalized = productType.trim();
  for (const rule of SCOPE_RULES) {
    if (normalized.startsWith(rule.prefix)) return rule.scope;
  }
  return "universal";
}

// ─── Scope → Hashtags ─────────────────────────────────────────────────
// Was a single global settings value (social_hashtags_fr/en) applied to every post
// regardless of category — e.g. a bathroom cabinet or a Christmas tree post tagged
// #jardinage #patio #mobilierexterieur. Scoped the same way as hooks, so the tags
// match what's actually in the photo.
export const SCOPE_HASHTAGS: Record<ProductScope, { fr: string; en: string }> = {
  outdoor_patio: { fr: "#jardinage #patio #mobilierexterieur #canada", en: "#garden #patio #outdoorfurniture #canada" },
  storage_kitchen: { fr: "#rangement #cuisine #organisation #canada", en: "#storage #kitchen #organization #canada" },
  mobilier_indoor: { fr: "#deco #meubles #salon #canada", en: "#homedecor #furniture #livingroom #canada" },
  pets: { fr: "#animaux #chien #chat #canada", en: "#pets #dog #cat #canada" },
  kids_toys_sport: { fr: "#enfants #jouets #pleinair #canada", en: "#kids #toys #outdoorplay #canada" },
  bedroom_decor: { fr: "#chambre #deco #maison #canada", en: "#bedroom #homedecor #canada" },
  seasonal_decor: { fr: "#halloween #noel #decosaisonniere #canada", en: "#halloween #christmas #seasonaldecor #canada" },
  universal: { fr: "#quebec #canada #maison", en: "#quebec #canada #home" },
};

export function hashtagsForScope(scope: ProductScope, language: "FR" | "EN"): string {
  const tags = SCOPE_HASHTAGS[scope];
  return language === "FR" ? tags.fr : tags.en;
}

// ─── Core selection logic ─────────────────────────────────────────────

function pickFromCandidates(candidates: ContentHook[]): ContentHook {
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function applyModeSplit(candidates: ContentHook[]): ContentHook {
  const usePool = Math.random() < 0.6;
  const preferred = candidates.filter((h) => h.mode === (usePool ? "pool" : "generative_seeded"));
  return pickFromCandidates(preferred.length > 0 ? preferred : candidates);
}

export async function selectHook(
  language: "FR" | "EN",
  productType: string | null | undefined,
  draftId: number | null = null
): Promise<HookSelection> {
  const scope = mapProductTypeToScope(productType);
  const recentCategoryIds = await getRecentHookCategoryIds(5);

  // Try with anti-repeat exclusion first, then without if empty
  let candidates = await selectCompatibleHooks(scope, language, recentCategoryIds);
  if (candidates.length === 0) {
    candidates = await selectCompatibleHooks(scope, language, []);
  }
  // Last resort: universal hooks only
  if (candidates.length === 0) {
    candidates = await selectCompatibleHooks("universal", language, []);
  }

  if (candidates.length === 0) {
    throw new Error(`No hooks found for language=${language} scope=${scope}`);
  }

  const chosen = applyModeSplit(candidates);
  await recordHookUsage(chosen.id, draftId);

  return {
    hookId: chosen.id,
    text: chosen.text,
    mode: chosen.mode,
    scope,
  };
}

// ─── Prompt injection helpers ─────────────────────────────────────────

/**
 * Build a hook-prepended prompt for Claude (FR).
 *
 * pool mode: Claude opens the post with the exact hook text verbatim.
 * generative_seeded: Claude is given the hook's spirit but allowed to vary the wording.
 */
export function buildHookedPrompt(basePrompt: string, hook: HookSelection): string {
  if (hook.mode === "pool") {
    return `Commence ton post par cette phrase d'accroche exacte (ne la modifie pas) :\n"${hook.text}"\n\nEnsuite, ${basePrompt}`;
  }
  return `Inspire-toi de cette idée d'accroche (tu peux reformuler avec tes mots) :\n"${hook.text}"\n\nEnsuite, ${basePrompt}`;
}

export function buildHookedPromptEn(basePrompt: string, hook: HookSelection): string {
  if (hook.mode === "pool") {
    return `Start your post with this exact hook sentence (do not modify it):\n"${hook.text}"\n\nThen, ${basePrompt}`;
  }
  return `Draw inspiration from this hook idea (you can rephrase it in your own words):\n"${hook.text}"\n\nThen, ${basePrompt}`;
}
