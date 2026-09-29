import { describe, it, expect, vi, beforeEach } from "vitest";

const shopifyFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify-client", () => ({
  shopifyFetch,
  parseLinkHeader: () => null,
}));
vi.mock("@/lib/database", () => ({
  getTrendStatsForShopifyProductIds: vi.fn(),
  getInStockShopifyIdsForCategory: vi.fn(),
  getProductDepartments: vi.fn(),
  getGuidePages: vi.fn(),
}));

import {
  listCollectionTopics,
  selectCollectionCandidates,
  isNearDuplicate,
  isInSeason,
  type CollectionTopic,
} from "@/lib/guide-collection-topics";
import { getTrendStatsForShopifyProductIds, getInStockShopifyIdsForCategory, getProductDepartments, getGuidePages } from "@/lib/database";
import type { GuidePageRow } from "@/lib/database";
import type { SubcategoryTrendStats } from "@/lib/database";

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Headers() });

const collections = [
  { id: 1, handle: "bureau-chaises", title: "Chaises de bureau", published_at: "x", rules: [{ column: "type", relation: "contains", condition: "Office Chairs" }] },
  { id: 2, handle: "rabais", title: "Rabais", published_at: "x", rules: [{ column: "tag", relation: "equals", condition: "sale" }] },
  { id: 3, handle: "cachee", title: "Cachée", published_at: null, rules: [{ column: "type", relation: "contains", condition: "X" }] },
  { id: 4, handle: "cuisine-tabourets-bar", title: "Tabourets de bar", published_at: "x", rules: [{ column: "type", relation: "contains", condition: "Bar Stools" }] },
  { id: 5, handle: "deco-saisonniere", title: "Déco saisonnière & Noël", published_at: "x", rules: [{ column: "type", relation: "contains", condition: "Home Furnishings > Holiday & Seasonal" }] },
  { id: 6, handle: "petite", title: "Petite", published_at: "x", rules: [{ column: "type", relation: "contains", condition: "Tiny" }] },
  { id: 7, handle: "meubles-deco", title: "Meubles & Déco", published_at: "x", rules: [{ column: "type", relation: "contains", condition: "Home Furnishings" }] },
  { id: 8, handle: "meubles-salle-de-bain", title: "Salle de bain", published_at: "x", rules: [{ column: "type", relation: "contains", condition: "Home Furnishings > Bedding & Bath" }] },
];
const members: Record<string, string[]> = {
  "1": ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11"],
  "4": ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"],
  "5": ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"],
  "6": ["d1", "d2"],
  "7": Array.from({ length: 50 }, (_, i) => `m${i}`),
  "8": Array.from({ length: 12 }, (_, i) => `s${i}`),
};

function stats(key: string, inStock: number, blended: number): SubcategoryTrendStats {
  return {
    aosomCategory: key, shopifyCollectionId: "x", shopifyCollectionTitle: key, inStockCount: inStock,
    minPrice: 10, maxPrice: 100, velocityScore: 0, priceDropScore: 0, blendedScore: blended, topProducts: [],
  };
}

beforeEach(() => {
  shopifyFetch.mockReset().mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith("/smart_collections.json")) return json({ smart_collections: collections });
    const m = endpoint.match(/^\/collections\/(\d+)\/products\.json/);
    if (m) return json({ products: (members[m[1]] ?? []).map((id) => ({ id })) });
    throw new Error(`unexpected ${endpoint}`);
  });
  vi.mocked(getTrendStatsForShopifyProductIds).mockReset().mockImplementation(async (meta, ids) =>
    ids.length === 0 ? null : { stats: stats(meta.aosomCategory, ids.length, meta.aosomCategory.includes("tabourets") ? 50 : 10), inStockIds: ids },
  );
  vi.mocked(getInStockShopifyIdsForCategory).mockReset().mockResolvedValue([]);
  vi.mocked(getProductDepartments).mockReset().mockResolvedValue(new Set(["Home Furnishings", "Patio & Garden"]));
  vi.mocked(getGuidePages).mockReset().mockResolvedValue([{ shopify_collection_title: "Salle de Bain" }] as unknown as GuidePageRow[]);
});

describe("listCollectionTopics", () => {
  it("keeps only published collections whose every rule is on product type", async () => {
    const topics = await listCollectionTopics();
    expect(topics.map((t) => t.handle)).toEqual(["bureau-chaises", "cuisine-tabourets-bar", "deco-saisonniere", "petite", "meubles-deco", "meubles-salle-de-bain"]);
    expect(topics[0]).toMatchObject({ key: "collection:bureau-chaises", collectionId: "1", title: "Chaises de bureau" });
  });
});

describe("isNearDuplicate", () => {
  const set = (n: number, prefix = "p") => new Set(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
  it("flags ≥80% overlap with a covering set of similar size", () => {
    expect(isNearDuplicate(set(10), set(11))).toBe(true);
  });
  it("does not flag a child of a much broader guide (the broad guide becomes its pillar)", () => {
    expect(isNearDuplicate(set(10), set(100))).toBe(false);
  });
  it("does not flag low overlap", () => {
    expect(isNearDuplicate(set(10), new Set([...set(5), ...set(20, "q")]))).toBe(false);
  });
});

describe("isInSeason", () => {
  const holiday = { productTypes: ["Home Furnishings > Holiday & Seasonal"], title: "Déco" } as CollectionTopic;
  it("is in season Oct 1 – Dec 10 for holiday topics only", () => {
    expect(isInSeason(holiday, new Date("2026-10-15T12:00:00Z"))).toBe(true);
    expect(isInSeason(holiday, new Date("2026-12-10T12:00:00Z"))).toBe(true);
    expect(isInSeason(holiday, new Date("2026-12-20T12:00:00Z"))).toBe(false);
    expect(isInSeason(holiday, new Date("2026-07-01T12:00:00Z"))).toBe(false);
    expect(isInSeason({ productTypes: ["Office Chairs"], title: "Chaises" } as CollectionTopic, new Date("2026-10-15T12:00:00Z"))).toBe(false);
  });
});

describe("selectCollectionCandidates", () => {
  it("skips topics under 10 in stock and already-covered keys; in-season first, then trend score", async () => {
    const r = await selectCollectionCandidates(3, new Set(["collection:bureau-chaises"]), new Date("2026-10-15T12:00:00Z"));
    expect(r.candidates.map((c) => c.collectionHandle)).toEqual(["deco-saisonniere", "cuisine-tabourets-bar"]);
    expect(r.remainingEligible).toBe(2);
    expect(r.skipped).toContainEqual(expect.objectContaining({ key: "collection:petite", reason: expect.stringContaining("moins de 10") }));
  });

  it("never picks a whole store department, nor a topic whose title an existing guide already has", async () => {
    const r = await selectCollectionCandidates(10, new Set(), new Date("2026-07-01T12:00:00Z"));
    const handles = r.candidates.map((c) => c.collectionHandle);
    expect(handles).not.toContain("meubles-deco");
    expect(handles).not.toContain("meubles-salle-de-bain");
    expect(r.skipped).toContainEqual(expect.objectContaining({ key: "collection:meubles-deco", reason: expect.stringContaining("rayon entier") }));
    expect(r.skipped).toContainEqual(expect.objectContaining({ key: "collection:meubles-salle-de-bain", reason: expect.stringContaining("titre identique") }));
  });

  it("out of season, the trend score decides", async () => {
    const r = await selectCollectionCandidates(1, new Set(["collection:bureau-chaises"]), new Date("2026-07-01T12:00:00Z"));
    expect(r.candidates.map((c) => c.collectionHandle)).toEqual(["cuisine-tabourets-bar"]);
    expect(r.remainingEligible).toBe(2);
  });

  it("skips a collection that is a near-duplicate of an existing subcategory guide", async () => {
    // The existing "Kitchen" guide already covers exactly the bar-stool products.
    vi.mocked(getInStockShopifyIdsForCategory).mockResolvedValue(members["4"]);
    const r = await selectCollectionCandidates(5, new Set(["Home Furnishings > Kitchen & Dining Furniture"]), new Date("2026-07-01T12:00:00Z"));
    expect(r.candidates.map((c) => c.collectionHandle)).not.toContain("cuisine-tabourets-bar");
    expect(r.skipped).toContainEqual(expect.objectContaining({ key: "collection:cuisine-tabourets-bar", reason: expect.stringContaining("doublon") }));
  });

  it("never gives two near-identical collections a page in the same run", async () => {
    members["4"] = [...members["1"]]; // Tabourets now has exactly the chairs' products
    try {
      const r = await selectCollectionCandidates(5, new Set(), new Date("2026-07-01T12:00:00Z"));
      const handles = r.candidates.map((c) => c.collectionHandle);
      expect(handles.filter((h) => h === "bureau-chaises" || h === "cuisine-tabourets-bar")).toHaveLength(1);
    } finally {
      members["4"] = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10"];
    }
  });
});
