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
  getGuidePageById: vi.fn(),
  updateGuidePageRetryResult: vi.fn(),
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
  updateBlogArticleBody: vi.fn(async () => undefined),
}));

const mockRunGuideQualityPipeline = vi.hoisted(() =>
  vi.fn(async () => ({
    factCheck: { score: 90, reasons: "ok" },
    qualityCheck: { score: 88, reasons: "ok" },
    overallScore: 88,
    overallStatus: "ready",
  })),
);
vi.mock("@/lib/guide-quality-pipeline", () => ({
  runGuideQualityPipeline: mockRunGuideQualityPipeline,
  RETRY_QUALITY_THRESHOLD: 70,
}));

import {
  selectPilotSubcategories,
  generateAndPushGuide,
  generatePilotGuides,
  getGuideCoverageStatus,
  extractCopyFromBodyHtml,
  retryExistingGuideQuality,
} from "@/lib/subcategory-guide-generator";
import {
  getSubcategoryTrendStats, createGuidePage, getAllCollectionMappings, getGuidePages,
  getGuidePageById, updateGuidePageRetryResult,
} from "@/lib/database";
import type { CollectionMapping, GuidePageRow } from "@/lib/database";
import { getShopifyCollectionHandle } from "@/lib/shopify-client";
import { createBlogArticle, updateBlogArticleBody } from "@/lib/shopify-blog";
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
  mockRunGuideQualityPipeline.mockReset().mockResolvedValue({
    factCheck: { score: 90, reasons: "ok" },
    qualityCheck: { score: 88, reasons: "ok" },
    overallScore: 88,
    overallStatus: "ready",
  });
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

  it("automatically retries once, targeted on the judge's feedback, when quality_score is below the retry threshold", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse).mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    mockRunGuideQualityPipeline
      .mockResolvedValueOnce({
        factCheck: { score: 90, reasons: "ok" },
        qualityCheck: { score: 55, reasons: "ton trop vendeur" },
        overallScore: 55,
        overallStatus: "attention",
      })
      .mockResolvedValueOnce({
        factCheck: { score: 90, reasons: "ok" },
        qualityCheck: { score: 85, reasons: "corrigé" },
        overallScore: 85,
        overallStatus: "ready",
      });

    await generateAndPushGuide(candidates[0]);

    // 1st Claude call = original generation, 2nd = the revision pass
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockRunGuideQualityPipeline).toHaveBeenCalledTimes(2);
    expect(createGuidePage).toHaveBeenCalledWith(
      expect.objectContaining({
        qualityScore: 85,
        qualityScoreBeforeRetry: 55,
        factCheckScoreBeforeRetry: 90,
        overallStatus: "ready",
      }),
    );
  });

  it("never retries more than once, even if the revision is still below threshold", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse).mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    mockRunGuideQualityPipeline.mockResolvedValue({
      factCheck: { score: 90, reasons: "ok" },
      qualityCheck: { score: 50, reasons: "toujours faible" },
      overallScore: 50,
      overallStatus: "attention",
    });

    await generateAndPushGuide(candidates[0]);

    expect(mockCreate).toHaveBeenCalledTimes(2); // generation + exactly 1 revision, never a 2nd revision
    expect(mockRunGuideQualityPipeline).toHaveBeenCalledTimes(2);
    expect(createGuidePage).toHaveBeenCalledWith(
      expect.objectContaining({ qualityScore: 50, qualityScoreBeforeRetry: 50 }),
    );
  });

  it("does not retry when quality_score already clears the threshold", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    await generateAndPushGuide(candidates[0]); // default mock verdict: quality 88

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRunGuideQualityPipeline).toHaveBeenCalledTimes(1);
    expect(createGuidePage).toHaveBeenCalledWith(
      expect.objectContaining({ qualityScoreBeforeRetry: undefined, factCheckScoreBeforeRetry: undefined }),
    );
  });

  it("keeps the original draft and still records the attempted-retry scores if the revision call itself throws", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse).mockRejectedValueOnce(new Error("Claude down mid-retry"));
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    mockRunGuideQualityPipeline.mockResolvedValueOnce({
      factCheck: { score: 90, reasons: "ok" },
      qualityCheck: { score: 55, reasons: "faible" },
      overallScore: 55,
      overallStatus: "attention",
    });

    const result = await generateAndPushGuide(candidates[0]);
    expect(result).toBeTruthy(); // never throws — falls back to the original draft
    expect(createGuidePage).toHaveBeenCalledWith(
      expect.objectContaining({ qualityScore: 55, qualityScoreBeforeRetry: 55 }),
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
    quality_score_before_retry: null,
    fact_check_score_before_retry: null,
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

describe("extractCopyFromBodyHtml — round-trips the real bodyHtml generateAndPushGuide produces", () => {
  it("recovers an equivalent structured copy from a real captured bodyHtml", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);

    await generateAndPushGuide(candidates[0]);
    const realBodyHtml = vi.mocked(createBlogArticle).mock.calls[0][0].bodyHtml;

    const extracted = extractCopyFromBodyHtml(realBodyHtml);
    const originalCopy = JSON.parse(goodCopyResponse.content[0].text);

    expect(extracted.introHtml).toBe(originalCopy.introHtml);
    expect(extracted.comparisonIntroHtml).toBe(originalCopy.comparisonIntroHtml);
    expect(extracted.chooseHtml).toBe(originalCopy.chooseHtml);
    expect(extracted.conclusionHtml).toBe(originalCopy.conclusionHtml);
    expect(extracted.faq).toEqual(originalCopy.faq);
  });

  it("throws a clear error rather than silently mangling content when the markers aren't found", () => {
    expect(() => extractCopyFromBodyHtml("<p>not a guide body at all</p>")).toThrow(/template markers not found/);
  });
});

describe("retryExistingGuideQuality", () => {
  const existingRow = {
    id: 27,
    aosom_category: "Patio & Garden > Patio Shade",
    shopify_collection_id: "1",
    shopify_collection_title: "Mobiliers extérieurs et jardins",
    status: "pending_review",
    skip_reason: null,
    shopify_article_id: "555",
    shopify_blog_id: 999,
    shopify_handle: "guide-achat-mobiliers-exterieurs-et-jardins-patio-shade",
    title: "Comment choisir : Mobiliers extérieurs et jardins (Patio Shade) — guide d'achat",
    min_price: 33.99,
    max_price: 421.99,
    in_stock_count: 46,
    body_html: null as string | null,
    fact_check_score: 92,
    fact_check_issues: "ok",
    quality_score: 62,
    quality_reasons: "introduction répète les chiffres, ton un peu générique",
    overall_status: "attention",
    quality_score_before_retry: null,
    fact_check_score_before_retry: null,
    created_at: 0,
  };

  it("regenerates with the stored judge feedback, updates the live Shopify draft in place, and records both scores", async () => {
    // First produce a real bodyHtml to use as the "existing" stored one.
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);
    await generateAndPushGuide(candidates[0]);
    const realBodyHtml = vi.mocked(createBlogArticle).mock.calls[0][0].bodyHtml;

    vi.mocked(getGuidePageById).mockResolvedValue({ ...existingRow, body_html: realBodyHtml } as unknown as GuidePageRow);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({ aosomCategory: "Patio & Garden > Patio Shade" })]);
    vi.mocked(getShopifyCollectionHandle).mockResolvedValue("mobiliers-exterieurs-et-jardins");

    mockCreate.mockResolvedValueOnce(goodCopyResponse); // the revision call
    mockRunGuideQualityPipeline.mockResolvedValueOnce({
      factCheck: { score: 92, reasons: "ok" },
      qualityCheck: { score: 84, reasons: "corrigé" },
      overallScore: 84,
      overallStatus: "ready",
    });

    const result = await retryExistingGuideQuality(27);

    expect(result).toEqual({
      guideId: 27,
      qualityScoreBefore: 62,
      qualityScoreAfter: 84,
      factCheckScoreBefore: 92,
      factCheckScoreAfter: 92,
      improved: true,
    });
    expect(updateBlogArticleBody).toHaveBeenCalledWith(999, "555", expect.stringContaining("BROUILLON"));
    expect(updateGuidePageRetryResult).toHaveBeenCalledWith(
      27,
      expect.objectContaining({ qualityScore: 84, qualityScoreBeforeRetry: 62, factCheckScoreBeforeRetry: 92 }),
    );
  });

  it("marks improved:false when the retry doesn't actually raise the score", async () => {
    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({})]);
    const { candidates } = await selectPilotSubcategories(1);
    await generateAndPushGuide(candidates[0]);
    const realBodyHtml = vi.mocked(createBlogArticle).mock.calls[0][0].bodyHtml;

    vi.mocked(getGuidePageById).mockResolvedValue({ ...existingRow, body_html: realBodyHtml } as unknown as GuidePageRow);
    vi.mocked(getSubcategoryTrendStats).mockResolvedValue([stats({ aosomCategory: "Patio & Garden > Patio Shade" })]);
    vi.mocked(getShopifyCollectionHandle).mockResolvedValue("mobiliers-exterieurs-et-jardins");

    mockCreate.mockResolvedValueOnce(goodCopyResponse);
    mockRunGuideQualityPipeline.mockResolvedValueOnce({
      factCheck: { score: 92, reasons: "ok" },
      qualityCheck: { score: 60, reasons: "toujours faible" },
      overallScore: 60,
      overallStatus: "attention",
    });

    const result = await retryExistingGuideQuality(27);
    expect(result.improved).toBe(false);
    expect(result.qualityScoreAfter).toBe(60);
  });

  it("refuses a guide that isn't pending_review", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue({ ...existingRow, status: "published" } as unknown as GuidePageRow);
    await expect(retryExistingGuideQuality(27)).rejects.toThrow(/not pending_review/);
  });

  it("refuses a guide with no stored quality_score", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue({ ...existingRow, body_html: "<p>x</p>", quality_score: null } as unknown as GuidePageRow);
    await expect(retryExistingGuideQuality(27)).rejects.toThrow(/no quality_score/);
  });
});
