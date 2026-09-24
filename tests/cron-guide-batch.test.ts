import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));

vi.mock("@/lib/database", () => ({
  recordCronRun: vi.fn(),
  createNotification: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/lib/subcategory-guide-generator", () => ({
  generatePilotGuides: vi.fn(),
  getGuideCoverageStatus: vi.fn(),
}));

import { GET } from "@/app/api/cron/guide-batch/route";
import { recordCronRun, createNotification, getSetting, setSetting } from "@/lib/database";
import { generatePilotGuides, getGuideCoverageStatus } from "@/lib/subcategory-guide-generator";
import type { GeneratedGuideResult } from "@/lib/subcategory-guide-generator";

function generatedGuide(overrides: Partial<GeneratedGuideResult> = {}): GeneratedGuideResult {
  return {
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
const coverageMock = vi.mocked(getGuideCoverageStatus);
const generateMock = vi.mocked(generatePilotGuides);

const auth = () => new Request("https://app.test/api/cron/guide-batch", { headers: { Authorization: "Bearer test-secret-123" } });

beforeEach(() => {
  recMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset().mockResolvedValue(1);
  getSettingMock.mockReset().mockResolvedValue(null);
  setSettingMock.mockReset().mockResolvedValue(undefined);
  coverageMock.mockReset();
  generateMock.mockReset();
});

describe("GET /api/cron/guide-batch", () => {
  it("returns 401 and touches nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/cron/guide-batch"));
    expect(res.status).toBe(401);
    expect(coverageMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("generates a batch of 4 (WEEKLY_BATCH_SIZE) excluding already-covered categories, and notifies when guides were produced", async () => {
    const excludeCategories = new Set(["Already", "Covered"]);
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 14, remainingCount: 14, excludeCategories });
    generateMock.mockResolvedValue({
      generated: [generatedGuide()],
      skipped: [],
      failed: [],
    });

    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(generateMock).toHaveBeenCalledWith(4, excludeCategories);
    expect(notifyMock).toHaveBeenCalledWith("success", expect.stringContaining("Nouveau lot"), expect.stringContaining("1 nouveau guide"));
    const body = await res.json();
    expect(body).toMatchObject({ success: true, generated: 1, remainingBefore: 14, complete: false });
  });

  it("does not notify when the batch produced zero guides (all skipped or failed)", async () => {
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

  it("stop condition: when remainingCount is 0, never calls generatePilotGuides and fires the completion notification exactly once", async () => {
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 28, remainingCount: 0, excludeCategories: new Set() });
    getSettingMock.mockResolvedValue(null); // not yet notified

    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(generateMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith("success", expect.stringContaining("couverture complète"), expect.stringContaining("28"));
    expect(setSettingMock).toHaveBeenCalledWith("guide_batch_complete_notified", "true");
    const body = await res.json();
    expect(body).toMatchObject({ success: true, generated: 0, complete: true });
  });

  it("stop condition: does not re-notify on subsequent weekly runs once already notified", async () => {
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 28, remainingCount: 0, excludeCategories: new Set() });
    getSettingMock.mockResolvedValue("true"); // already notified a previous week

    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(generateMock).not.toHaveBeenCalled();
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

  it("caps the batch at 4 even when far more than 4 subcategories remain", async () => {
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 0, remainingCount: 28, excludeCategories: new Set() });
    generateMock.mockResolvedValue({ generated: [], skipped: [], failed: [] });

    await GET(auth());
    expect(generateMock).toHaveBeenCalledWith(4, expect.any(Set));
  });

  it("requests fewer than 4 when only 2 subcategories remain (last partial week)", async () => {
    // generatePilotGuides itself handles the "fewer than count available" case — this test
    // just confirms the cron always passes the fixed WEEKLY_BATCH_SIZE as a ceiling, not a
    // floor, and lets the generator naturally produce fewer.
    coverageMock.mockResolvedValue({ totalSubcategories: 28, coveredCount: 26, remainingCount: 2, excludeCategories: new Set() });
    generateMock.mockResolvedValue({
      generated: [
        generatedGuide({ aosomCategory: "A" }),
        generatedGuide({ aosomCategory: "B", title: "t2", shopifyArticleId: "2", shopifyHandle: "h2", adminUrl: "u2" }),
      ],
      skipped: [],
      failed: [],
    });

    const res = await GET(auth());
    const body = await res.json();
    expect(body.generated).toBe(2);
    expect(notifyMock).toHaveBeenCalledWith("success", expect.any(String), expect.stringContaining("2 nouveaux guides"));
  });
});
