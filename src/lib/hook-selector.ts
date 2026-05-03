/**
 * Hook Selector — picks a hook from the pool for a given product and language.
 *
 * Strategy:
 * - Map product_type → one of 6 scopes (outdoor_patio, storage_organization,
 *   mobilier_indoor, pets_kids, bedroom_bath, home_office). Unknown → "mobilier_indoor".
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
  | "storage_organization"
  | "mobilier_indoor"
  | "pets_kids"
  | "bedroom_bath"
  | "home_office";

export interface HookSelection {
  hookId: number;
  text: string;
  mode: "pool" | "generative_seeded";
  scope: ProductScope;
}

// ─── Product Type → Scope Mapping ────────────────────────────────────

const SCOPE_RULES: Array<{ prefix: string; scope: ProductScope }> = [
  { prefix: "Patio, Lawn & Garden", scope: "outdoor_patio" },
  { prefix: "Garden", scope: "outdoor_patio" },
  { prefix: "Outdoor", scope: "outdoor_patio" },
  { prefix: "Storage & Organization", scope: "storage_organization" },
  { prefix: "Storage", scope: "storage_organization" },
  { prefix: "Organization", scope: "storage_organization" },
  { prefix: "Pet Supplies", scope: "pets_kids" },
  { prefix: "Pets", scope: "pets_kids" },
  { prefix: "Toys & Games", scope: "pets_kids" },
  { prefix: "Baby", scope: "pets_kids" },
  { prefix: "Kids", scope: "pets_kids" },
  { prefix: "Bedroom", scope: "bedroom_bath" },
  { prefix: "Bath", scope: "bedroom_bath" },
  { prefix: "Home Office", scope: "home_office" },
  { prefix: "Office", scope: "home_office" },
  // Home Furnishings sub-paths
  { prefix: "Home Furnishings > Bedroom", scope: "bedroom_bath" },
  { prefix: "Home Furnishings > Office", scope: "home_office" },
  { prefix: "Home Furnishings > Storage", scope: "storage_organization" },
  // Catch-all indoor furniture
  { prefix: "Home Furnishings", scope: "mobilier_indoor" },
  { prefix: "Furniture", scope: "mobilier_indoor" },
  { prefix: "Living", scope: "mobilier_indoor" },
  { prefix: "Dining", scope: "mobilier_indoor" },
  { prefix: "Kitchen", scope: "mobilier_indoor" },
];

export function mapProductTypeToScope(productType: string | null | undefined): ProductScope {
  if (!productType) return "mobilier_indoor";
  const normalized = productType.trim();
  // Longest-prefix-first already guaranteed by order above (sub-paths before parent)
  for (const rule of SCOPE_RULES) {
    if (normalized.startsWith(rule.prefix)) return rule.scope;
  }
  return "mobilier_indoor";
}

// ─── Core selection logic ─────────────────────────────────────────────

function pickFromCandidates(candidates: ContentHook[]): ContentHook {
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
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

  // Try with exclusion first, then without if nothing matches
  let candidates = await selectCompatibleHooks(scope, language, recentCategoryIds);
  if (candidates.length === 0) {
    candidates = await selectCompatibleHooks(scope, language, []);
  }
  // Last resort: any hook in this language
  if (candidates.length === 0) {
    candidates = await selectCompatibleHooks("mobilier_indoor", language, []);
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

// ─── Prompt injection helper ──────────────────────────────────────────

/**
 * Build a hook-prepended prompt for Claude.
 *
 * pool mode: Claude is told to open the post with the exact hook text verbatim.
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
