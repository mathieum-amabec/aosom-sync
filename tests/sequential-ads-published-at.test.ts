import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the /sequential-ads card reporting a publish that already happened
 * as if it were still days away.
 *
 * "Publier maintenant" posts immediately and deliberately leaves `scheduled_at` alone, so a
 * published ad routinely carries a slot still in the future. Two real rows on 2026-08-19:
 *
 *   id 468  scheduled_at 2026-08-21 13:00  published_at 2026-08-19 01:24:35
 *   id 469  scheduled_at 2026-08-20 13:00  published_at 2026-08-19 13:01:46
 *
 * The queue API never exposed `published_at`, so the card fell back to the slot and rendered
 * "Publié le 21 août" for an ad that went out on the 19th.
 */

const auth = { isAuthenticated: vi.fn(), getSessionRole: vi.fn() };
vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => auth.isAuthenticated(),
  getSessionRole: () => auth.getSessionRole(),
}));

const db = { getSequentialAdQueueItems: vi.fn() };
vi.mock("@/lib/database", () => ({
  getSequentialAdQueueItems: () => db.getSequentialAdQueueItems(),
}));

const { GET } = await import("@/app/api/sequential-ads/queue/route");

const ROW = {
  id: 468,
  contentId: "seqad:demand_gen:1",
  status: "published",
  scheduledAt: "2026-08-21 13:00:00",
  publishedAt: "2026-08-19 01:24:35",
  createdAt: "2026-08-18 10:00:00",
  payload: JSON.stringify({ caption: "Patio", brand: "Ameublo Direct" }),
  metadata: { style: "demand_gen_messages", campaign: "patio" },
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  db.getSequentialAdQueueItems.mockResolvedValue([ROW]);
});

describe("GET /api/sequential-ads/queue — published_at", () => {
  it("exposes published_at so the card can show when the ad actually went out", async () => {
    const body = await (await GET()).json();
    expect(body.items[0].published_at).toBe("2026-08-19 01:24:35");
  });

  it("keeps published_at DISTINCT from scheduled_at — an early publish leaves a future slot", async () => {
    const item = (await (await GET()).json()).items[0];
    expect(item.scheduled_at).toBe("2026-08-21 13:00:00");
    expect(item.published_at).not.toBe(item.scheduled_at);
    expect(item.published_at < item.scheduled_at).toBe(true);
  });

  it("returns null (not undefined) for an item that has not published yet", async () => {
    db.getSequentialAdQueueItems.mockResolvedValue([
      { ...ROW, id: 465, status: "pending", publishedAt: null },
    ]);
    const item = (await (await GET()).json()).items[0];
    expect(item.published_at).toBeNull();
    expect("published_at" in item).toBe(true);
  });

  it("tolerates a row whose publishedAt field is absent entirely", async () => {
    const { publishedAt, ...without } = ROW;
    void publishedAt;
    db.getSequentialAdQueueItems.mockResolvedValue([without]);
    expect((await (await GET()).json()).items[0].published_at).toBeNull();
  });

  it("stays admin-only", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await GET()).status).toBe(403);
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await GET()).status).toBe(401);
  });
});
