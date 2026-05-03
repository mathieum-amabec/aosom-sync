/**
 * Unit tests for hook-selector.ts
 *
 * Tests pure logic only:
 * - mapProductTypeToScope() prefix mapping
 * - buildHookedPrompt() / buildHookedPromptEn() injection format
 * - applyModeSplit() distribution (via selectHook with mocked DB)
 * - Edge cases: null product type, unknown product type, empty candidates fallback
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mapProductTypeToScope, buildHookedPrompt, buildHookedPromptEn, selectHook } from "@/lib/hook-selector";
import type { HookSelection } from "@/lib/hook-selector";
import * as database from "@/lib/database";
import { HOOKS_SEED } from "@/lib/seed/hooks-seed";

// ─── mapProductTypeToScope ────────────────────────────────────────────

describe("mapProductTypeToScope", () => {
  // ── Outdoor / Patio
  it("maps Patio, Lawn & Garden → outdoor_patio", () => {
    expect(mapProductTypeToScope("Patio, Lawn & Garden")).toBe("outdoor_patio");
  });

  it("maps sub-path Patio, Lawn & Garden > Chairs → outdoor_patio", () => {
    expect(mapProductTypeToScope("Patio, Lawn & Garden > Chairs")).toBe("outdoor_patio");
  });

  it("maps Patio & Garden → outdoor_patio", () => {
    expect(mapProductTypeToScope("Patio & Garden")).toBe("outdoor_patio");
  });

  // ── Storage & Kitchen
  it("maps Home Furnishings > Storage → storage_kitchen", () => {
    expect(mapProductTypeToScope("Home Furnishings > Storage")).toBe("storage_kitchen");
  });

  it("maps Home Furnishings > Storage > Shelving → storage_kitchen", () => {
    expect(mapProductTypeToScope("Home Furnishings > Storage > Shelving")).toBe("storage_kitchen");
  });

  it("maps Appliances → storage_kitchen", () => {
    expect(mapProductTypeToScope("Appliances")).toBe("storage_kitchen");
  });

  // ── Pets
  it("maps Pet Supplies → pets", () => {
    expect(mapProductTypeToScope("Pet Supplies")).toBe("pets");
  });

  it("maps Pet Supplies > Dog Beds → pets", () => {
    expect(mapProductTypeToScope("Pet Supplies > Dog Beds")).toBe("pets");
  });

  // ── Kids Toys & Sports
  it("maps Toys & Games → kids_toys_sport", () => {
    expect(mapProductTypeToScope("Toys & Games")).toBe("kids_toys_sport");
  });

  it("maps Toys & Games > Electric Cars → kids_toys_sport", () => {
    expect(mapProductTypeToScope("Toys & Games > Electric Cars")).toBe("kids_toys_sport");
  });

  it("maps Sports & Recreation > Trampolines → kids_toys_sport", () => {
    expect(mapProductTypeToScope("Sports & Recreation > Trampolines")).toBe("kids_toys_sport");
  });

  // ── Bedroom & Decor
  it("maps Home Furnishings > Bedroom → bedroom_decor (sub-path before parent)", () => {
    expect(mapProductTypeToScope("Home Furnishings > Bedroom")).toBe("bedroom_decor");
  });

  it("maps Bedding & Bath → bedroom_decor", () => {
    expect(mapProductTypeToScope("Bedding & Bath")).toBe("bedroom_decor");
  });

  // ── Mobilier indoor (home_office merged)
  it("maps Home Furnishings > Office → mobilier_indoor (home_office merged)", () => {
    expect(mapProductTypeToScope("Home Furnishings > Office")).toBe("mobilier_indoor");
  });

  it("maps Office Products → mobilier_indoor", () => {
    expect(mapProductTypeToScope("Office Products")).toBe("mobilier_indoor");
  });

  it("maps Office Products > Office Desks → mobilier_indoor", () => {
    expect(mapProductTypeToScope("Office Products > Office Desks")).toBe("mobilier_indoor");
  });

  it("maps Home Furnishings (no sub-path) → mobilier_indoor", () => {
    expect(mapProductTypeToScope("Home Furnishings")).toBe("mobilier_indoor");
  });

  it("maps Furniture → mobilier_indoor", () => {
    expect(mapProductTypeToScope("Furniture")).toBe("mobilier_indoor");
  });

  // ── Universal fallback
  it("maps null → universal (default)", () => {
    expect(mapProductTypeToScope(null)).toBe("universal");
  });

  it("maps undefined → universal (default)", () => {
    expect(mapProductTypeToScope(undefined)).toBe("universal");
  });

  it("maps empty string → universal (default)", () => {
    expect(mapProductTypeToScope("")).toBe("universal");
  });

  it("maps unknown product type → universal (fallback)", () => {
    expect(mapProductTypeToScope("Health & Beauty")).toBe("universal");
  });
});

// ─── buildHookedPrompt ────────────────────────────────────────────────

describe("buildHookedPrompt (FR)", () => {
  const basePrompt = "Rédige un post Facebook pour ce produit.";

  it("pool mode: includes exact hook text verbatim in quotes", () => {
    const hook: HookSelection = { hookId: 1, text: "Votre maison, c'est votre signature.", mode: "pool", scope: "mobilier_indoor" };
    const result = buildHookedPrompt(basePrompt, hook);
    expect(result).toContain(`"${hook.text}"`);
  });

  it("pool mode: instructs Claude not to modify the hook", () => {
    const hook: HookSelection = { hookId: 1, text: "Stock limité.", mode: "pool", scope: "outdoor_patio" };
    const result = buildHookedPrompt(basePrompt, hook);
    expect(result.toLowerCase()).toMatch(/ne la modifie pas|exacte/);
  });

  it("pool mode: still includes the base prompt", () => {
    const hook: HookSelection = { hookId: 1, text: "Votre signature.", mode: "pool", scope: "mobilier_indoor" };
    const result = buildHookedPrompt(basePrompt, hook);
    expect(result).toContain(basePrompt);
  });

  it("generative_seeded mode: includes hook text but allows rephrasing", () => {
    const hook: HookSelection = { hookId: 2, text: "Imagine ton espace idéal.", mode: "generative_seeded", scope: "mobilier_indoor" };
    const result = buildHookedPrompt(basePrompt, hook);
    expect(result).toContain(hook.text);
    expect(result.toLowerCase()).toMatch(/reformuler|inspire/);
  });

  it("generative_seeded mode: still includes the base prompt", () => {
    const hook: HookSelection = { hookId: 2, text: "Imagine.", mode: "generative_seeded", scope: "outdoor_patio" };
    const result = buildHookedPrompt(basePrompt, hook);
    expect(result).toContain(basePrompt);
  });

  it("pool mode result is longer than base prompt alone", () => {
    const hook: HookSelection = { hookId: 1, text: "Un crochet.", mode: "pool", scope: "mobilier_indoor" };
    const result = buildHookedPrompt(basePrompt, hook);
    expect(result.length).toBeGreaterThan(basePrompt.length);
  });
});

describe("buildHookedPromptEn (EN)", () => {
  const basePrompt = "Write a Facebook post for this product.";

  it("pool mode: includes exact hook text verbatim", () => {
    const hook: HookSelection = { hookId: 3, text: "Your home is your signature.", mode: "pool", scope: "mobilier_indoor" };
    const result = buildHookedPromptEn(basePrompt, hook);
    expect(result).toContain(`"${hook.text}"`);
  });

  it("pool mode: instructs not to modify the hook", () => {
    const hook: HookSelection = { hookId: 3, text: "Your home.", mode: "pool", scope: "mobilier_indoor" };
    const result = buildHookedPromptEn(basePrompt, hook);
    expect(result.toLowerCase()).toMatch(/do not modify|exact/);
  });

  it("generative_seeded mode: hook idea present but flexible", () => {
    const hook: HookSelection = { hookId: 4, text: "Picture your perfect space.", mode: "generative_seeded", scope: "outdoor_patio" };
    const result = buildHookedPromptEn(basePrompt, hook);
    expect(result).toContain(hook.text);
    expect(result.toLowerCase()).toMatch(/rephrase|inspiration|inspire/);
  });
});

// ─── selectHook (with mocked DB) ─────────────────────────────────────

vi.mock("@/lib/database", () => ({
  getRecentHookCategoryIds: vi.fn().mockResolvedValue([]),
  selectCompatibleHooks: vi.fn().mockResolvedValue([
    { id: 10, categoryId: 1, language: "FR", text: "Votre maison, c'est votre signature.", productScopes: ["universal"], mode: "pool", usedCount: 0, lastUsedAt: null },
    { id: 11, categoryId: 2, language: "FR", text: "Qualité durable.", productScopes: ["universal"], mode: "generative_seeded", usedCount: 0, lastUsedAt: null },
  ]),
  recordHookUsage: vi.fn().mockResolvedValue(undefined),
}));

const mockGetRecentCategoryIds = vi.mocked(database.getRecentHookCategoryIds);
const mockSelectCompatibleHooks = vi.mocked(database.selectCompatibleHooks);
const mockRecordHookUsage = vi.mocked(database.recordHookUsage);

const DEFAULT_HOOKS = [
  { id: 10, categoryId: 1, language: "FR" as const, text: "Votre maison, c'est votre signature.", productScopes: ["universal"], mode: "pool" as const, usedCount: 0, lastUsedAt: null },
  { id: 11, categoryId: 2, language: "FR" as const, text: "Qualité durable.", productScopes: ["universal"], mode: "generative_seeded" as const, usedCount: 0, lastUsedAt: null },
];

describe("selectHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRecentCategoryIds.mockResolvedValue([]);
    mockSelectCompatibleHooks.mockResolvedValue(DEFAULT_HOOKS);
    mockRecordHookUsage.mockResolvedValue(undefined);
  });

  it("returns a HookSelection with hookId, text, mode, scope", async () => {
    const result = await selectHook("FR", "Patio, Lawn & Garden", null);
    expect(result.hookId).toBeTypeOf("number");
    expect(result.text).toBeTypeOf("string");
    expect(result.text.length).toBeGreaterThan(0);
    expect(["pool", "generative_seeded"]).toContain(result.mode);
    expect(result.scope).toBe("outdoor_patio");
  });

  it("calls recordHookUsage after selecting", async () => {
    await selectHook("FR", "Home Furnishings", null);
    expect(mockRecordHookUsage).toHaveBeenCalledOnce();
  });

  it("maps Pet Supplies to pets scope before querying", async () => {
    await selectHook("FR", "Pet Supplies", null);
    expect(mockSelectCompatibleHooks.mock.calls[0][0]).toBe("pets");
  });

  it("maps Toys & Games to kids_toys_sport scope before querying", async () => {
    await selectHook("FR", "Toys & Games", null);
    expect(mockSelectCompatibleHooks.mock.calls[0][0]).toBe("kids_toys_sport");
  });

  it("passes language correctly to selectCompatibleHooks", async () => {
    await selectHook("EN", "Furniture", null);
    expect(mockSelectCompatibleHooks.mock.calls[0][1]).toBe("EN");
  });

  it("falls back without exclusions when first query returns empty", async () => {
    mockSelectCompatibleHooks
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { id: 10, categoryId: 1, language: "FR" as const, text: "Fallback hook.", productScopes: ["universal"], mode: "pool" as const, usedCount: 0, lastUsedAt: null },
      ]);
    const result = await selectHook("FR", "Furniture", null);
    expect(result.hookId).toBe(10);
    expect(mockSelectCompatibleHooks).toHaveBeenCalledTimes(2);
  });

  it("throws when all fallbacks return empty", async () => {
    mockSelectCompatibleHooks.mockResolvedValue([]);
    await expect(selectHook("FR", "Home Furnishings", null)).rejects.toThrow("No hooks found");
  });
});

// ─── HOOKS_SEED array validation ──────────────────────────────────────

describe("HOOKS_SEED array", () => {
  it("contains exactly 200 hooks (100 FR + 100 EN)", () => {
    expect(HOOKS_SEED).toHaveLength(200);
    expect(HOOKS_SEED.filter(h => h.language === "FR")).toHaveLength(100);
    expect(HOOKS_SEED.filter(h => h.language === "EN")).toHaveLength(100);
  });

  it("covers all 7 expected scopes", () => {
    const expectedScopes = ["universal", "mobilier_indoor", "outdoor_patio", "pets", "kids_toys_sport", "storage_kitchen", "bedroom_decor"];
    const allScopes = new Set(HOOKS_SEED.flatMap(h => h.productScopes));
    for (const scope of expectedScopes) {
      expect(allScopes).toContain(scope);
    }
  });

  it("has no duplicate texts within the same language", () => {
    for (const lang of ["FR", "EN"] as const) {
      const texts = HOOKS_SEED.filter(h => h.language === lang).map(h => h.text);
      const unique = new Set(texts);
      expect(unique.size).toBe(texts.length);
    }
  });

  it("mobilier_indoor scope reaches ≥30 hooks per language (incl. multi-tagged)", () => {
    const frMob = HOOKS_SEED.filter(h => h.language === "FR" && h.productScopes.includes("mobilier_indoor"));
    const enMob = HOOKS_SEED.filter(h => h.language === "EN" && h.productScopes.includes("mobilier_indoor"));
    expect(frMob.length).toBeGreaterThanOrEqual(30);
    expect(enMob.length).toBeGreaterThanOrEqual(30);
  });

  it("universal hooks present in both languages (≥5 each, forms fallback pool)", () => {
    const frUniv = HOOKS_SEED.filter(h => h.language === "FR" && h.productScopes.includes("universal"));
    const enUniv = HOOKS_SEED.filter(h => h.language === "EN" && h.productScopes.includes("universal"));
    expect(frUniv.length).toBeGreaterThanOrEqual(5);
    expect(enUniv.length).toBeGreaterThanOrEqual(5);
  });
});
