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
  env: { hasGbp: true, gbpAutoPublish: false },
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch" },
}));

vi.mock("@/lib/llm-budget", () => ({
  budgetedCreate: async (client: { messages: { create: (p: unknown) => unknown } }, params: unknown) =>
    client.messages.create(params),
}));

vi.mock("@/lib/database", () => ({
  getGbpTrendCandidates: vi.fn(),
  getRecentGbpCategories: vi.fn(),
  createGbpPost: vi.fn(async () => 42),
}));

vi.mock("@/lib/shopify-client", () => ({
  getShopifyProductTitle: vi.fn(async (_id: string, fallback: string) => fallback === "Product" ? "Titre FR réel" : fallback),
}));

import {
  selectWeeklyProduct,
  generateWeeklyGbpPost,
  judgeGbpPost,
} from "@/lib/gbp-post-generator";
import { getGbpTrendCandidates, getRecentGbpCategories, createGbpPost } from "@/lib/database";
import type { GbpTrendCandidate } from "@/lib/database";

function candidate(overrides: Partial<GbpTrendCandidate>): GbpTrendCandidate {
  return {
    sku: "SKU-1",
    name: "Product",
    price: 199.99,
    image1: "https://example.com/img.jpg",
    product_type: "Meubles",
    shopify_product_id: "111",
    shopify_handle: "product-handle",
    velocity_score: 5,
    price_drop_score: 0,
    blended_score: 0.5,
    signal_type: "stock",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(getGbpTrendCandidates).mockReset();
  vi.mocked(getRecentGbpCategories).mockReset();
  vi.mocked(createGbpPost).mockClear();
  mockCreate.mockReset();
});

describe("selectWeeklyProduct", () => {
  it("skips a category used in the last posts, picking the next-best candidate", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([
      candidate({ sku: "A", product_type: "Patio", blended_score: 0.9 }),
      candidate({ sku: "B", product_type: "Meubles", blended_score: 0.7 }),
    ]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue(["Patio"]);

    const pick = await selectWeeklyProduct();
    expect(pick?.sku).toBe("B");
  });

  it("falls back to the top score when every candidate's category was recently used", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([
      candidate({ sku: "A", product_type: "Patio", blended_score: 0.9 }),
      candidate({ sku: "B", product_type: "Patio", blended_score: 0.7 }),
    ]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue(["Patio"]);

    const pick = await selectWeeklyProduct();
    expect(pick?.sku).toBe("A");
  });

  it("returns null when there are no candidates at all", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue([]);

    const pick = await selectWeeklyProduct();
    expect(pick).toBeNull();
  });
});

describe("generateWeeklyGbpPost", () => {
  it("returns null when there is no eligible product", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue([]);

    const result = await generateWeeklyGbpPost();
    expect(result).toBeNull();
    expect(createGbpPost).not.toHaveBeenCalled();
  });

  it("strips a leaked supplier brand name before storing, even if the judge would have passed it", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([candidate({})]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue([]);

    // 1st call: post generation (leaks a forbidden brand). 2nd call: judge.
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Ce fauteuil Outsunny est en rabais cette semaine." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"score": 85, "reasons": "ok"}' }] });

    const result = await generateWeeklyGbpPost();
    expect(result?.summary).not.toMatch(/outsunny/i);
    expect(createGbpPost).toHaveBeenCalledWith(
      expect.objectContaining({ summaryFr: expect.not.stringMatching(/outsunny/i) }),
    );
  });

  it("marks a low judge score as rejected, not pending_review", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([candidate({})]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue([]);

    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Post générique sans lien avec le produit." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"score": 40, "reasons": "hors sujet"}' }] });

    await generateWeeklyGbpPost();
    expect(createGbpPost).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected", judgeScore: 40 }));
  });

  it("marks a passing judge score as pending_review (never auto-publishes from here)", async () => {
    vi.mocked(getGbpTrendCandidates).mockResolvedValue([candidate({})]);
    vi.mocked(getRecentGbpCategories).mockResolvedValue([]);

    mockCreate
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Ce fauteuil se vend vite cette semaine — venez le voir." }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: '{"score": 88, "reasons": "cohérent"}' }] });

    await generateWeeklyGbpPost();
    expect(createGbpPost).toHaveBeenCalledWith(expect.objectContaining({ status: "pending_review", judgeScore: 88 }));
  });
});

describe("judgeGbpPost", () => {
  it("clamps an out-of-range score into 0-100", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: '{"score": 140, "reasons": "trop généreux"}' }] });
    const verdict = await judgeGbpPost("texte", candidate({}), "Titre");
    expect(verdict.score).toBe(100);
  });

  it("throws on unparseable judge output", async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "not json at all" }] });
    await expect(judgeGbpPost("texte", candidate({}), "Titre")).rejects.toThrow();
  });
});
