import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/config", () => ({
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch" },
}));

vi.mock("@/lib/llm-budget", () => ({
  budgetedCreate: async (client: { messages: { create: (p: unknown) => unknown } }, params: unknown) =>
    client.messages.create(params),
}));

import { factCheckGuideCopy, qualityCheckGuideCopy, runGuideQualityPipeline } from "@/lib/guide-quality-pipeline";
import type { SubcategoryTrendStats } from "@/lib/database";

/** Mocked Claude response shape, including `usage` (both production functions log real token
 * counts from it — see guide-quality-pipeline.ts). */
function resp(text: string) {
  return { content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } };
}

const stats: SubcategoryTrendStats = {
  aosomCategory: "Patio & Garden > Patio Furniture",
  shopifyCollectionId: "1",
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
};
const titles = ["Chaise A", "Chaise B"];
const copy = {
  introHtml: "<p>Intro.</p>",
  comparisonIntroHtml: "<p>Comparons.</p>",
  chooseHtml: "<p>Choisissez.</p>",
  conclusionHtml: "<p>Conclusion.</p>",
  faq: [{ question: "Q1?", answer: "R1." }],
};

beforeEach(() => {
  mockCreate.mockReset();
});

describe("factCheckGuideCopy", () => {
  it("parses a valid verdict", async () => {
    mockCreate.mockResolvedValueOnce(resp('{"score": 95, "reasons": "aucune divergence"}'));
    const verdict = await factCheckGuideCopy(stats, titles, copy);
    expect(verdict).toEqual({ score: 95, reasons: "aucune divergence" });
  });

  it("throws on invalid JSON rather than silently passing", async () => {
    mockCreate.mockResolvedValueOnce(resp("not json"));
    await expect(factCheckGuideCopy(stats, titles, copy)).rejects.toThrow(/invalid JSON/);
  });

  it("salvages a score from JSON truncated mid-\"reasons\" string instead of losing the verdict", async () => {
    mockCreate.mockResolvedValueOnce(resp('{"score": 82, "reasons": "Le prix mentionné correspond bien mais la description est un peu long'));
    const verdict = await factCheckGuideCopy(stats, titles, copy);
    expect(verdict.score).toBe(82);
    expect(verdict.reasons).toMatch(/Le prix mentionné/);
  });

  it("includes the real trend/price-drop signal in the prompt so a true rabais claim isn't flagged as unverifiable", async () => {
    mockCreate.mockResolvedValueOnce(resp('{"score": 100, "reasons": "aucune"}'));
    await factCheckGuideCopy(stats, titles, copy);
    const promptText = mockCreate.mock.calls[0][0].messages[0].content as string;
    expect(promptText).toMatch(/Rabais réel détecté.*10 %/);
  });
});

describe("qualityCheckGuideCopy", () => {
  it("parses a valid verdict", async () => {
    mockCreate.mockResolvedValueOnce(resp('{"score": 82, "reasons": "bon"}'));
    const verdict = await qualityCheckGuideCopy(copy);
    expect(verdict).toEqual({ score: 82, reasons: "bon" });
  });

  it("clamps an out-of-range score", async () => {
    mockCreate.mockResolvedValueOnce(resp('{"score": -10, "reasons": "trop sévère"}'));
    const verdict = await qualityCheckGuideCopy(copy);
    expect(verdict.score).toBe(0);
  });
});

describe("runGuideQualityPipeline", () => {
  it("runs both passes and takes the minimum score as overallScore", async () => {
    mockCreate
      .mockResolvedValueOnce(resp('{"score": 95, "reasons": "ok"}'))
      .mockResolvedValueOnce(resp('{"score": 70, "reasons": "ton un peu faible"}'));

    const result = await runGuideQualityPipeline(stats, titles, copy);
    expect(result.overallScore).toBe(70);
    expect(result.overallStatus).toBe("attention");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("marks 'ready' only when both passes clear the 80 threshold", async () => {
    mockCreate
      .mockResolvedValueOnce(resp('{"score": 85, "reasons": "ok"}'))
      .mockResolvedValueOnce(resp('{"score": 90, "reasons": "ok"}'));

    const result = await runGuideQualityPipeline(stats, titles, copy);
    expect(result.overallStatus).toBe("ready");
  });
});
