import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));

const generateAndQueueRemix = vi.fn();
vi.mock("@/lib/slideshow/remix", () => ({
  REMIX_THEMES: ["ete-cour", "maison", "enfants", "bureau", "animaux", "soldes"],
  generateAndQueueRemix: (...args: unknown[]) => generateAndQueueRemix(...args),
}));

vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { GET, isoWeek } from "@/app/api/cron/remix/route";

const auth = (secret = "test-secret-123") =>
  new Request("https://app.test/api/cron/remix", { headers: { Authorization: `Bearer ${secret}` } });

describe("isoWeek", () => {
  it("is deterministic and cycles through the 6 remix themes over consecutive weeks", () => {
    const weeks = [0, 1, 2, 3, 4, 5, 6].map((i) => isoWeek(new Date(Date.UTC(2026, 0, 5 + i * 7))));
    // Consecutive Mondays 7 days apart must land on consecutive ISO week numbers.
    for (let i = 1; i < weeks.length; i++) {
      expect(weeks[i]).toBe(weeks[i - 1] + 1);
    }
  });
});

describe("GET /api/cron/remix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s without a valid Bearer token, and never calls generateAndQueueRemix", async () => {
    const res = await GET(new Request("https://app.test/api/cron/remix"));
    expect(res.status).toBe(401);
    expect(generateAndQueueRemix).not.toHaveBeenCalled();
  });

  it("picks a theme from REMIX_THEMES and delegates to generateAndQueueRemix (draft-only, no publish)", async () => {
    generateAndQueueRemix.mockResolvedValue({ queueId: 7, theme: "maison", clipCount: 8, blobUrl: "https://blob.example/x.mp4" });
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(generateAndQueueRemix).toHaveBeenCalledTimes(1);
    const arg = generateAndQueueRemix.mock.calls[0][0];
    expect(["ete-cour", "maison", "enfants", "bureau", "animaux", "soldes"]).toContain(arg.theme);
  });

  it("returns 500 (not a silent success) when generation fails", async () => {
    generateAndQueueRemix.mockRejectedValue(new Error("no free video slot"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
  });
});
