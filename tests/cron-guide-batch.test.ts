import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));

vi.mock("@/lib/database", () => ({
  recordCronRun: vi.fn(),
  createNotification: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getGuidePages: vi.fn(),
}));

vi.mock("@/lib/subcategory-guide-generator", () => ({
  generatePilotGuides: vi.fn(),
  generateCollectionGuides: vi.fn(),
  getGuideCoverageStatus: vi.fn(),
}));

import { GET } from "@/app/api/cron/guide-batch/route";
import { recordCronRun, createNotification, getSetting, setSetting, getGuidePages } from "@/lib/database";
import type { GuidePageRow } from "@/lib/database";
import { generatePilotGuides, generateCollectionGuides, getGuideCoverageStatus } from "@/lib/subcategory-guide-generator";
import type { GeneratedGuideResult } from "@/lib/subcategory-guide-generator";

function generatedGuide(overrides: Partial<GeneratedGuideResult> = {}): GeneratedGuideResult {
  return {
    guidePageId: 1,
    aosomCategory: "A",
    title: "t",
    shopifyArticleId: "1",
    shopifyHandle: "h",
    adminUrl: "u",
    pillarGuideMissing: true,
    ...overrides,
  };
}

const recMock = vi.mocked(recordCronRun);
const notifyMock = vi.mocked(createNotification);
const getSettingMock = vi.mocked(getSetting);
const setSettingMock = vi.mocked(setSetting);
const guidesMock = vi.mocked(getGuidePages);
const coverageMock = vi.mocked(getGuideCoverageStatus);
const generateMock = vi.mocked(generatePilotGuides);
const collectionMock = vi.mocked(generateCollectionGuides);

const auth = () => new Request("https://app.test/api/cron/guide-batch", { headers: { Authorization: "Bearer test-secret-123" } });
const pending = (n: number, scheduled = false) =>
  Array.from({ length: n }, (_, i) => ({ id: i, status: "pending_review", scheduled_publish_at: scheduled ? "2026-10-01 14:00:00" : null })) as unknown as GuidePageRow[];

beforeEach(() => {
  recMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset().mockResolvedValue(1);
  getSettingMock.mockReset().mockResolvedValue(null);
  setSettingMock.mockReset().mockResolvedValue(undefined);
  guidesMock.mockReset().mockResolvedValue([]);
  coverageMock.mockReset();
  generateMock.mockReset();
  collectionMock.mockReset();
});

describe("GET /api/cron/guide-batch", () => {
  it("returns 401 and touches nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/cron/guide-batch"));
    expect(res.status).toBe(401);
    expect(coverageMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("subcategories first: a batch of 2 (= publish cadence) excluding covered categories, notifies when produced", async () => {
    const excludeCategories = new Set(["Already", "Covered"]);
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 14, remainingCount: 14, excludeCategories });
    generateMock.mockResolvedValue({ generated: [generatedGuide()], skipped: [], failed: [] });

    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledWith(2, excludeCategories);
    expect(collectionMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith("success", expect.stringContaining("Nouveau lot"), expect.stringContaining("1 nouveau guide"));
    expect(await res.json()).toMatchObject({ success: true, generated: 1, remainingBefore: 14, complete: false, source: "subcategories" });
  });

  it("once every subcategory is covered, moves on to collection topics", async () => {
    const excludeCategories = new Set(["A"]);
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 28, remainingCount: 0, excludeCategories });
    collectionMock.mockResolvedValue({ generated: [{ ...generatedGuide(), status: "ready" }, { ...generatedGuide({ guidePageId: 2 }), status: "attention" }], failed: [], remainingEligible: 60 });

    const res = await GET(auth());
    expect(collectionMock).toHaveBeenCalledWith(2, excludeCategories);
    expect(generateMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith("success", expect.any(String), expect.stringContaining("2 nouveaux guides"));
    expect(await res.json()).toMatchObject({ generated: 2, remainingBefore: 60, complete: false, source: "collections" });
  });

  it("pauses (generates nothing) while 6+ generated guides are still waiting for review", async () => {
    guidesMock.mockResolvedValue([...pending(6), ...pending(10, true)]);
    const res = await GET(auth());
    expect(coverageMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(collectionMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ success: true, paused: true, awaitingReview: 6, generated: 0 });
    expect(recMock).toHaveBeenCalledWith("guide-batch", "success", expect.stringContaining("paused"));
  });

  it("approved/scheduled guides don't count toward the review backlog", async () => {
    guidesMock.mockResolvedValue([...pending(5), ...pending(20, true)]);
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 28, remainingCount: 0, excludeCategories: new Set() });
    collectionMock.mockResolvedValue({ generated: [], failed: [], remainingEligible: 3 });
    await GET(auth());
    expect(collectionMock).toHaveBeenCalled();
  });

  it("does not notify when the batch produced zero guides", async () => {
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 14, remainingCount: 14, excludeCategories: new Set() });
    generateMock.mockResolvedValue({
      generated: [],
      skipped: [{ aosomCategory: "X", shopifyCollectionId: "1", shopifyCollectionTitle: "X", reason: "no stock" }],
      failed: [],
    });
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stop condition: both sources exhausted → completion notification exactly once", async () => {
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 28, remainingCount: 0, excludeCategories: new Set() });
    collectionMock.mockResolvedValue({ generated: [], failed: [], remainingEligible: 0 });

    const res = await GET(auth());
    expect(notifyMock).toHaveBeenCalledWith("success", expect.stringContaining("couverture complète"), expect.stringContaining("28"));
    expect(setSettingMock).toHaveBeenCalledWith("guide_batch_complete_notified", "true");
    expect(await res.json()).toMatchObject({ success: true, generated: 0, complete: true });

    notifyMock.mockClear();
    setSettingMock.mockClear();
    getSettingMock.mockResolvedValue("true");
    await GET(auth());
    expect(notifyMock).not.toHaveBeenCalled();
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it("records an error run and returns 500 when the batch generator throws", async () => {
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 14, remainingCount: 14, excludeCategories: new Set() });
    generateMock.mockRejectedValue(new Error("Claude down"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
    expect(recMock).toHaveBeenCalledWith("guide-batch", "error", "Claude down");
  });
});
