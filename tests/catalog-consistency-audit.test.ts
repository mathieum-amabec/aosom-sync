import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { shopifyAccessToken: "test-token" },
  SHOPIFY: { STORE: "test.myshopify.com", API_VERSION: "2025-01" },
}));
const { setSettingMock } = vi.hoisted(() => ({ setSettingMock: vi.fn() }));
vi.mock("@/lib/database", () => ({ setSetting: setSettingMock }));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.stubGlobal("fetch", fetchMock);

import {
  runCatalogConsistencyAudit,
  persistCatalogConsistencyAudit,
  detectDuplicateColorOption,
} from "@/lib/catalog-consistency-audit";

function shopifyPage(products: unknown[], nextLink: string | null = null) {
  return {
    ok: true,
    headers: { get: (h: string) => (h.toLowerCase() === "link" && nextLink ? `<${nextLink}>; rel="next"` : null) },
    json: async () => ({ products }),
  };
}

const cleanProduct = {
  id: 1,
  title: "Chaise longue",
  handle: "chaise-longue",
  status: "active",
  body_html: "<p>Cette chaise est parfaite pour votre jardin, avec des accoudoirs confortables.</p>",
  options: [{ name: "Couleur", values: ["Rouge", "Bleu"] }],
  variants: [
    { sku: "A-RD", option1: "Rouge", option2: null, option3: null },
    { sku: "A-BU", option1: "Bleu", option2: null, option3: null },
  ],
};

const englishProduct = {
  id: 2,
  title: "Lounge Chair",
  handle: "lounge-chair",
  status: "active",
  body_html: "<p>This chair is great for your garden and easy to clean with the included cover.</p>",
  options: [],
  variants: [{ sku: "B-01", option1: null, option2: null, option3: null }],
};

const leakingProduct = {
  id: 3,
  title: "Table de jardin",
  handle: "table-de-jardin",
  status: "active",
  body_html: "<p>Cette table Outsunny est parfaite pour votre jardin et facile à nettoyer.</p>",
  options: [],
  variants: [{ sku: "C-01", option1: null, option2: null, option3: null }],
};

const duplicateColorProduct = {
  id: 4,
  title: "Coffre à outils",
  handle: "coffre-outils",
  status: "active",
  body_html: "<p>Ce coffre à outils est parfait pour votre garage, avec des roulettes solides.</p>",
  options: [{ name: "Couleur", values: ["Red", "Rouge"] }],
  variants: [
    { sku: "E2-0007", option1: "Red", option2: "Large", option3: null },
    { sku: "B20-109V00RD", option1: "Rouge", option2: '24.3" x 13" x 42.5"', option3: null },
  ],
};

const draftProduct = { ...cleanProduct, id: 5, status: "draft" };

describe("detectDuplicateColorOption", () => {
  it("returns null when the Couleur values are all genuinely distinct", () => {
    expect(detectDuplicateColorOption(cleanProduct)).toBeNull();
  });

  it("flags two raw values that translate to the same French color", () => {
    const detail = detectDuplicateColorOption(duplicateColorProduct);
    expect(detail).toContain("Red");
    expect(detail).toContain("Rouge");
  });

  it("returns null when there is no Couleur option at all", () => {
    expect(detectDuplicateColorOption(englishProduct)).toBeNull();
  });
});

describe("runCatalogConsistencyAudit", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    setSettingMock.mockReset().mockResolvedValue(undefined);
  });

  it("counts each defect exactly once per product and skips non-active products", async () => {
    fetchMock.mockResolvedValueOnce(
      shopifyPage([cleanProduct, englishProduct, leakingProduct, duplicateColorProduct, draftProduct]),
    );
    const result = await runCatalogConsistencyAudit();
    expect(result.totalActive).toBe(4); // draftProduct excluded
    expect(result.englishDescriptions).toBe(1);
    expect(result.brandLeaks).toBe(1);
    expect(result.duplicateColorOptions).toBe(1);
    expect(result.issues.map((i) => i.kind).sort()).toEqual(
      ["brand_leak", "duplicate_color_option", "english_description"].sort(),
    );
  });

  it("paginates via the Shopify Link header", async () => {
    fetchMock
      .mockResolvedValueOnce(shopifyPage([cleanProduct], "https://test.myshopify.com/admin/api/2025-01/products.json?page_info=abc"))
      .mockResolvedValueOnce(shopifyPage([englishProduct]));
    const result = await runCatalogConsistencyAudit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.totalActive).toBe(2);
  });

  it("never issues a write request — every call is a plain GET with no body", async () => {
    fetchMock.mockResolvedValueOnce(shopifyPage([cleanProduct]));
    await runCatalogConsistencyAudit();
    for (const call of fetchMock.mock.calls) {
      const opts = call[1] as RequestInit | undefined;
      expect(opts?.method ?? "GET").toBe("GET");
      expect(opts?.body).toBeUndefined();
    }
  });
});

describe("persistCatalogConsistencyAudit", () => {
  it("writes the summary to the settings store", async () => {
    const result = {
      auditedAt: 123,
      totalActive: 10,
      englishDescriptions: 1,
      brandLeaks: 0,
      duplicateColorOptions: 0,
      issues: [],
    };
    await persistCatalogConsistencyAudit(result);
    expect(setSettingMock).toHaveBeenCalledWith("catalog_consistency_audit", JSON.stringify(result));
  });
});
