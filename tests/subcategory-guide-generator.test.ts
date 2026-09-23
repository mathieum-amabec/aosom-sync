import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", async () => {
  const actual = await vi.importActual<typeof import("@/lib/content-generator")>("@/lib/content-generator");
  return {
    ...actual,
    getAnthropicClient: () => ({ messages: { create: mockCreate } }),
  };
});

vi.mock("@/lib/config", () => ({
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch" },
  BLOG: { GUIDES_FR_ID: 999 },
}));

vi.mock("@/lib/llm-budget", () => ({
  budgetedCreate: async (client: { messages: { create: (p: unknown) => unknown } }, params: unknown) =>
    client.messages.create(params),
}));

vi.mock("@/lib/database", () => ({
  getSubcategoryTrendStats: vi.fn(),
  createGuidePage: vi.fn(async () => 1),
  getAllCollectionMappings: vi.fn(),
  getGuidePages: vi.fn(),
}));

vi.mock("@/lib/shopify-client", () => ({
  getShopifyProductTitle: vi.fn(async (_id: string, fallback: string) => `FR ${fallback}`),
  getShopifyCollectionHandle: vi.fn(async () => "real-collection-handle"),
}));

vi.mock("@/lib/selectors/shopify-images", () => ({
  resolveLifestyle: vi.fn(async () => ({ verified: false, primaryImageUrl: "https://cdn.shopify.com/img.jpg" })),
}));

vi.mock("@/lib/shopify-blog", () => ({
  createBlogArticle: vi.fn(async () => ({
    articleId: "111",
    blogId: 999,
    handle: "guide-achat-test",
    adminUrl: "https://admin/articles/111",
  })),
}));

vi.mock("@/lib/guide-quality-pipeline", () => ({
  runGuideQualityPipeline: vi.fn(async () => ({
    factCheck: { score: 90, reasons: "ok" },
    qualityCheck: { score: 88, reasons: "ok" },
    overallScore: 88,
    overallStatus: "ready",
  })),
}));

import {
  selectPilotSubcategories,
  generateAndPushGuide,
  generatePilotGuides,
  getGuideCoverageStatus,
} from "@/lib/subcategory-guide-generator";
import { getSubcategoryTrendStats, createGuidePage, getAllCollectionMappings, getGuidePages } from "@/lib/database";
import type { CollectionMapping, GuidePageRow } from "@/lib/database";
import { getShopifyCollectionHandle } from "@/lib/shopify-client";
import { createBlogArticle } from "@/lib/shopify-blog";
import type { SubcategoryTrendStats } from "@/lib/database";

function stats(overrides: Partial<SubcategoryTrendStats>): SubcategoryTrendStats {
  return {
    aosomCategory: "Patio & Garden > Patio Furniture",
    shopifyCollectionId: "111",
    shopifyCollectionTitle: "Chaises et tables de patio",
    inStockCount: 10,
    minPrice: 99.99,
    maxPrice: 499.99,
    velocityScore: 5,
    priceDropScore: 0.1,
    blendedScore: 7,
    topProducts: [
      { sku: "A", name: "Chair A", price: 199.99, image1: "", shopify_product_id: "1", shopify_handle: "chair-a", units_moved: 3 },
      { sku: "B", name: "Chair B", price: 299.99, image1: "", shopify_product_id: "2", shopify_handle: "chair-b", units_moved: 1 },
    ],
    ...overrides,
  };
}

const goodCopyResponse = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        introHtml: "<p>Intro réelle.</p>",
        comparisonIntroHtml: "<p>Comparons.</p>",
        chooseHtml: "<p>Choisissez selon votre budget.</p><ul><li>Critère 1</li></ul>",
        conclusionHtml: "<p>Conclusion.</p>",
        faq: [
          { question: "Combien ça coûte?", answer: "Entre 99,99 $ et 499,99 $." },
          { question: "Quelle taille choisir?", answer: "Selon votre espace." },
        ],
      }),
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

beforeEach(() => {
  vi.mocked(getSubcategoryTrendStats).mockReset();
  vi.mocked(createGuidePage).mockClear();
  vi.mocked(getShopifyCollectionHandle).mockClear();
  vi.mocked(createBlogArticle).mockClear();
  mockCreate.mockReset();
});

describe("selectPilotSubcategories", () => {
  it("accepts a subcategory with >=2 in-stock products and a resolvable collection handle", async () => {
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);

    const { candidates, skipped } = await selectPilotSubcategories(5);
    expect(candidates).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("skips (with a reason, never silently) a subcategory with fewer than 2 in-stock products", async () => {
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([
      stats({ aosomCategory: "Thin", topProducts: [{ sku: "A", name: "Only one", price: 50, image1: "", shopify_product_id: "1", shopify_handle: "a", units_moved: 0 }] }),
      stats({ aosomCategory: "Fine", shopifyCollectionId: "222" }),
    ]);

    const { candidates, skipped } = await selectPilotSubcategories(5);
    expect(candidates.map((c) => c.stats.aosomCategory)).toEqual(["Fine"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/comparatif réel/);
  });

  it("skips when the real Shopify collection handle can't be resolved (never guesses one)", async () => {
    vi.mocked(getShopifyCollectionHandle).mockResolvedValueOnce(null);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);

    const { candidates, skipped } = await selectPilotSubcategories(5);
    expect(candidates).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/collection_mappings/);
  });

  it("stops once `count` real candidates are accepted, even if more exist", async () => {
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([
      stats({ aosomCategory: "A" }),
      stats({ aosomCategory: "B", shopifyCollectionId: "2" }),
      stats({ aosomCategory: "C", shopifyCollectionId: "3" }),
    ]);

    const { candidates } = await selectPilotSubcategories(2);
    expect(candidates).toHaveLength(2);
  });

  it("never regenerates a subcategory already in excludeCategories", async () => {
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([
      stats({ aosomCategory: "Already covered" }),
      stats({ aosomCategory: "New one", shopifyCollectionId: "2" }),
    ]);

    const { candidates } = await selectPilotSubcategories(5, new Set(["Already covered"]));
    expect(candidates.map((c) => c.stats.aosomCategory)).toEqual(["New one"]);
  });
});

describe("generateAndPushGuide", () => {
  it("always creates the article as a draft, embeds the review banner, and flags the missing pillar guide", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    const { candidates } = await (async () => {
      vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
      return selectPilotSubcategories(1);
    })();

    const result = await generateAndPushGuide(candidates[0]);

    expect(createBlogArticle).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(createBlogArticle).mock.calls[0][0];
    expect(callArg.blogIdOverride).toBe(999);
    expect(callArg.bodyHtml).toMatch(/BROUILLON/);
    expect(callArg.bodyHtml).toMatch(/application\/ld\+json/);
    expect(result.pillarGuideMissing).toBe(true);
    expect(createGuidePage).toHaveBeenCalledWith(expect.objectContaining({ status: "pending_review" }));
  });

  it("includes real product images in the comparison table, JSON-LD, and as the article's featured image", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    await generateAndPushGuide(candidates[0]);
    const callArg = vi.mocked(createBlogArticle).mock.calls[0][0];
    expect(callArg.bodyHtml).toMatch(/<img src="https:\/\/cdn\.shopify\.com\/img\.jpg"/);
    expect(callArg.bodyHtml).toMatch(/"image":"https:\/\/cdn\.shopify\.com\/img\.jpg"/);
    expect(callArg.featuredImage).toEqual({ src: "https://cdn.shopify.com/img.jpg", alt: expect.any(String) });
  });

  it("stores the quality pipeline verdict and the full body_html alongside the article", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    await generateAndPushGuide(candidates[0]);
    expect(createGuidePage).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyHtml: expect.stringContaining("BROUILLON"),
        factCheckScore: 90,
        qualityScore: 88,
        overallStatus: "ready",
      }),
    );
  });

  it("retries with a disambiguated handle when Shopify reports the primary handle already taken", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([
      stats({ aosomCategory: "Patio & Garden > Fire Pits" }),
    ]);
    const { candidates } = await selectPilotSubcategories(1);

    vi.mocked(createBlogArticle)
      .mockRejectedValueOnce(new Error('Shopify blog article create failed: 422 — {"errors":{"handle":["has already been taken"]}}'))
      .mockResolvedValueOnce({
        articleId: "222",
        blogId: 999,
        handle: "guide-achat-chaises-et-tables-de-patio-fire-pits",
        adminUrl: "https://admin/articles/222",
      });

    const result = await generateAndPushGuide(candidates[0]);
    expect(createBlogArticle).toHaveBeenCalledTimes(2);
    expect(result.shopifyHandle).toBe("guide-achat-chaises-et-tables-de-patio-fire-pits");
  });

  it("does not swallow a createBlogArticle failure that isn't a handle collision", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    vi.mocked(createBlogArticle).mockRejectedValueOnce(new Error("Shopify blog article create failed: 500 — server error"));
    await expect(generateAndPushGuide(candidates[0])).rejects.toThrow(/500/);
    expect(createBlogArticle).toHaveBeenCalledTimes(1);
  });

  it("strips a leaked supplier brand from the generated copy before it reaches the article body", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ ...JSON.parse(goodCopyResponse.content[0].text), introHtml: "<p>Ces chaises Outsunny sont populaires.</p>" }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    await generateAndPushGuide(candidates[0]);
    const callArg = vi.mocked(createBlogArticle).mock.calls[0][0];
    expect(callArg.bodyHtml).not.toMatch(/outsunny/i);
  });
});

describe("generatePilotGuides", () => {
  it("records every skip and continues generating the rest, never throwing for a data gap", async () => {
    mockCreate.mockResolvedValue(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([
      stats({ aosomCategory: "Thin", topProducts: [] }),
      stats({ aosomCategory: "Good", shopifyCollectionId: "2" }),
    ]);

    const result = await generatePilotGuides(5);
    expect(result.skipped).toHaveLength(1);
    expect(result.generated).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    // one createGuidePage call for the skip, one for the generated guide
    expect(createGuidePage).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped_empty" }));
  });

  it("records a per-candidate failure without losing the rest of the batch", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Claude down")).mockResolvedValue(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([
      stats({ aosomCategory: "Broken" }),
      stats({ aosomCategory: "Fine", shopifyCollectionId: "2" }),
    ]);

    const result = await generatePilotGuides(5);
    expect(result.failed).toEqual([{ aosomCategory: "Broken", error: "Claude down" }]);
    expect(result.generated).toHaveLength(1);
  });
});

function mapping(overrides: Partial<CollectionMapping>): CollectionMapping {
  return {
    aosomCategory: "Sub A",
    collectionRole: "sub",
    shopifyCollectionId: "1",
    shopifyCollectionTitle: "A",
    ...overrides,
  };
}

function guideRow(overrides: Partial<GuidePageRow>): GuidePageRow {
  return {
    id: 1,
    aosom_category: "Sub A",
    shopify_collection_id: "1",
    shopify_collection_title: "A",
    status: "pending_review",
    skip_reason: null,
    shopify_article_id: null,
    shopify_blog_id: null,
    shopify_handle: null,
    title: null,
    min_price: null,
    max_price: null,
    in_stock_count: null,
    body_html: null,
    fact_check_score: null,
    fact_check_issues: null,
    quality_score: null,
    quality_reasons: null,
    overall_status: null,
    created_at: 0,
    ...overrides,
  };
}

describe("getGuideCoverageStatus", () => {
  beforeEach(() => {
    vi.mocked(getAllCollectionMappings).mockReset();
    vi.mocked(getGuidePages).mockReset();
  });

  it("counts only 'sub' mappings, and treats any guide_pages row (any status) as covered", async () => {
    vi.mocked(getAllCollectionMappings).mockResolvedValue([
      mapping({ aosomCategory: "Main Cat", collectionRole: "main", shopifyCollectionId: "0", shopifyCollectionTitle: "Main" }),
      mapping({ aosomCategory: "Sub A", shopifyCollectionId: "1", shopifyCollectionTitle: "A" }),
      mapping({ aosomCategory: "Sub B", shopifyCollectionId: "2", shopifyCollectionTitle: "B" }),
      mapping({ aosomCategory: "Sub C", shopifyCollectionId: "3", shopifyCollectionTitle: "C" }),
    ]);
    vi.mocked(getGuidePages).mockResolvedValue([
      guideRow({ aosom_category: "Sub A", status: "pending_review" }),
      guideRow({ aosom_category: "Sub B", status: "skipped_empty" }),
    ]);

    const status = await getGuideCoverageStatus();
    expect(status.totalSubcategories).toBe(3); // "Main Cat" excluded — role='main'
    expect(status.coveredCount).toBe(2); // A (pending_review) + B (skipped_empty) both count
    expect(status.remainingCount).toBe(1); // only C remains
    expect(status.excludeCategories.has("Sub C")).toBe(false);
    expect(status.excludeCategories.has("Sub A")).toBe(true);
  });

  it("reports remainingCount 0 once every 'sub' mapping has a guide_pages row", async () => {
    vi.mocked(getAllCollectionMappings).mockResolvedValue([mapping({ aosomCategory: "Sub A" })]);
    vi.mocked(getGuidePages).mockResolvedValue([guideRow({ aosom_category: "Sub A", status: "published" })]);

    const status = await getGuideCoverageStatus();
    expect(status.remainingCount).toBe(0);
  });
});
