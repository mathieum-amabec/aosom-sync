import { describe, it, expect, vi, beforeEach } from "vitest";

const cronAuth = vi.hoisted(() => ({ verifyCronSecret: vi.fn() }));
vi.mock("@/lib/cron-auth", () => cronAuth);
vi.mock("@/lib/cron-tracking", () => ({
  trackCron: vi.fn(async (_name: string, fn: () => Promise<unknown>, summarize?: (r: never) => string) => {
    const r = await fn();
    summarize?.(r as never); // the summary must never throw either
    return r;
  }),
}));
const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn() }));
vi.mock("@/lib/auth", () => auth);
const db = vi.hoisted(() => ({ listReelsToMeasure: vi.fn(), saveReelInsight: vi.fn(), getReelResultRows: vi.fn() }));
vi.mock("@/lib/database", () => db);
const client = vi.hoisted(() => ({ fetchFacebookReelInsights: vi.fn() }));
vi.mock("@/lib/reel-insights-client", () => client);

import { GET as cron } from "@/app/api/cron/reel-insights/route";
import { GET as insights } from "@/app/api/ameublo/insights/route";

const M = { plays: 5, initialPlays: 4, avgWatchMs: 3000, totalWatchMs: 9000, socialActions: 0 };
const req = (url = "http://x/api/cron/reel-insights", authz = "Bearer s") => new Request(url, { headers: { authorization: authz } });

beforeEach(() => {
  vi.clearAllMocks();
  cronAuth.verifyCronSecret.mockReturnValue(true);
  auth.isAuthenticated.mockResolvedValue(true);
  db.listReelsToMeasure.mockResolvedValue([]);
  db.saveReelInsight.mockResolvedValue(undefined);
  db.getReelResultRows.mockResolvedValue([]);
  client.fetchFacebookReelInsights.mockResolvedValue(M);
});

describe("GET /api/cron/reel-insights", () => {
  it("is closed without the cron secret", async () => {
    cronAuth.verifyCronSecret.mockReturnValue(false);
    expect((await cron(req())).status).toBe(401);
    expect(db.listReelsToMeasure).not.toHaveBeenCalled();
  });

  it("measures every Reel with a Facebook id and stores one snapshot each", async () => {
    db.listReelsToMeasure.mockResolvedValue([
      { queueId: 1, fbPostId: "FB1", brand: "ameublo", publishedAt: null },
      { queueId: 2, fbPostId: "FB2", brand: "furnish", publishedAt: null },
    ]);
    const j = await (await cron(req())).json();
    expect(j.data).toMatchObject({ total: 2, measured: 2, failed: 0, skipped: 0 });
    expect(client.fetchFacebookReelInsights).toHaveBeenCalledWith("FB2", "furnish");
    expect(db.saveReelInsight).toHaveBeenCalledWith(2, "facebook", "FB2", M);
    expect(db.listReelsToMeasure).toHaveBeenCalledWith(14);
  });

  it("one Reel failing (deleted, token hiccup) is counted and does not stop the others", async () => {
    db.listReelsToMeasure.mockResolvedValue([
      { queueId: 1, fbPostId: "FB1", brand: "ameublo", publishedAt: null },
      { queueId: 2, fbPostId: "FB2", brand: "ameublo", publishedAt: null },
    ]);
    client.fetchFacebookReelInsights.mockRejectedValueOnce(new Error("Facebook insights FB1: gone")).mockResolvedValueOnce(M);
    const j = await (await cron(req())).json();
    expect(j.data).toMatchObject({ measured: 1, failed: 1, firstError: "Facebook insights FB1: gone" });
    expect(db.saveReelInsight).toHaveBeenCalledTimes(1);
  });

  it("answers 500 (and records the failure) when the whole run blows up", async () => {
    db.listReelsToMeasure.mockRejectedValue(new Error("turso down"));
    expect((await cron(req())).status).toBe(500);
  });
});

describe("GET /api/ameublo/insights", () => {
  it("401 without a session", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await insights(new Request("http://x/api/ameublo/insights"))).status).toBe(401);
  });

  it("returns the rows and the tables built from them, 14 days by default and never more than 60", async () => {
    db.getReelResultRows.mockResolvedValue([
      { queueId: 1, contentType: "sequential_ad", style: "vote", lang: "en", label: "L", studioVideoId: 3, scheduledAt: "2026-10-06 11:50:00", publishedAt: null, plays: 9, avgWatchMs: 2000, totalWatchMs: 1, socialActions: 0, measuredOn: "2026-10-07", ageHours: 100 },
    ]);
    const j = await (await insights(new Request("http://x/api/ameublo/insights"))).json();
    expect(db.getReelResultRows).toHaveBeenCalledWith(14);
    expect(j.data.summary).toMatchObject({ measured: 1, totalPlays: 9 });
    expect(j.data.summary.bySlot[0].key).toBe("07:45");
    await insights(new Request("http://x/api/ameublo/insights?days=9999"));
    expect(db.getReelResultRows).toHaveBeenLastCalledWith(60);
  });
});
