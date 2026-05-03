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

// ─── mapProductTypeToScope ────────────────────────────────────────────

describe("mapProductTypeToScope", () => {
  it("maps Patio, Lawn & Garden → outdoor_patio", () => {
    expect(mapProductTypeToScope("Patio, Lawn & Garden")).toBe("outdoor_patio");
  });

  it("maps sub-path Patio, Lawn & Garden > Chairs → outdoor_patio", () => {
    expect(mapProductTypeToScope("Patio, Lawn & Garden > Chairs")).toBe("outdoor_patio");
  });

  it("maps Storage & Organization → storage_organization", () => {
    expect(mapProductTypeToScope("Storage & Organization")).toBe("storage_organization");
  });

  it("maps Storage & Organization > Shelving → storage_organization", () => {
    expect(mapProductTypeToScope("Storage & Organization > Shelving")).toBe("storage_organization");
  });

  it("maps Pet Supplies → pets_kids", () => {
    expect(mapProductTypeToScope("Pet Supplies")).toBe("pets_kids");
  });

  it("maps Toys & Games → pets_kids", () => {
    expect(mapProductTypeToScope("Toys & Games")).toBe("pets_kids");
  });

  it("maps Baby → pets_kids", () => {
    expect(mapProductTypeToScope("Baby")).toBe("pets_kids");
  });

  it("maps Bedroom → bedroom_bath", () => {
    expect(mapProductTypeToScope("Bedroom")).toBe("bedroom_bath");
  });

  it("maps Home Office → home_office", () => {
    expect(mapProductTypeToScope("Home Office")).toBe("home_office");
  });

  it("maps Home Furnishings > Bedroom → bedroom_bath (sub-path before parent)", () => {
    expect(mapProductTypeToScope("Home Furnishings > Bedroom")).toBe("bedroom_bath");
  });

  it("maps Home Furnishings > Office → home_office", () => {
    expect(mapProductTypeToScope("Home Furnishings > Office")).toBe("home_office");
  });

  it("maps Home Furnishings > Storage → storage_organization", () => {
    expect(mapProductTypeToScope("Home Furnishings > Storage")).toBe("storage_organization");
  });

  it("maps Home Furnishings (no sub-path) → mobilier_indoor", () => {
    expect(mapProductTypeToScope("Home Furnishings")).toBe("mobilier_indoor");
  });

  it("maps Furniture → mobilier_indoor", () => {
    expect(mapProductTypeToScope("Furniture")).toBe("mobilier_indoor");
  });

  it("maps null → mobilier_indoor (default)", () => {
    expect(mapProductTypeToScope(null)).toBe("mobilier_indoor");
  });

  it("maps undefined → mobilier_indoor (default)", () => {
    expect(mapProductTypeToScope(undefined)).toBe("mobilier_indoor");
  });

  it("maps empty string → mobilier_indoor (default)", () => {
    expect(mapProductTypeToScope("")).toBe("mobilier_indoor");
  });

  it("maps unknown product type → mobilier_indoor (default)", () => {
    expect(mapProductTypeToScope("Health & Beauty")).toBe("mobilier_indoor");
  });

  it("maps Health & Beauty → mobilier_indoor (fallback for unmapped types)", () => {
    expect(mapProductTypeToScope("Health & Beauty > Hair Care")).toBe("mobilier_indoor");
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

  it("maps product type to scope correctly before querying", async () => {
    await selectHook("FR", "Pet Supplies", null);
    expect(mockSelectCompatibleHooks.mock.calls[0][0]).toBe("pets_kids");
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
