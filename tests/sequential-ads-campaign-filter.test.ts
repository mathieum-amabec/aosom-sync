import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The /sequential-ads list was capped at 50 rows while 134 non-cancelled sequential ads
 * existed. Two things followed, both silent:
 *
 *   - 11 of automne-2026's 29 ads never reached the page, so the campaign filter — which ran
 *     in the browser over the already-truncated page — could not show them either.
 *   - patio-ete-2026, halloween-2026 and noel-2026 fell off entirely. The dropdown built its
 *     options from the returned page, so those campaigns were not even selectable. Eight
 *     Christmas drafts scheduled 1 Oct to 1 Dec were unreachable for approval.
 *
 * These tests pin the contract that fixes it: filter in SQL, cap higher, and compute the
 * campaign list over every row rather than over the page.
 */

const auth = { isAuthenticated: vi.fn(), getSessionRole: vi.fn() };
vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => auth.isAuthenticated(),
  getSessionRole: () => auth.getSessionRole(),
}));

const db = {
  getSequentialAdQueueItems: vi.fn(),
  getSequentialAdCampaigns: vi.fn(),
  countSequentialAdQueueItems: vi.fn(),
};
vi.mock("@/lib/database", () => ({
  getSequentialAdQueueItems: (limit?: number, campaign?: string | null) =>
    db.getSequentialAdQueueItems(limit, campaign),
  getSequentialAdCampaigns: () => db.getSequentialAdCampaigns(),
  countSequentialAdQueueItems: (campaign?: string | null) => db.countSequentialAdQueueItems(campaign),
}));

const { GET } = await import("@/app/api/sequential-ads/queue/route");

const req = (qs = "") => new Request(`http://localhost/api/sequential-ads/queue${qs}`);

function row(id: number, campaign: string) {
  return {
    id,
    contentId: `seqad:ugc_video:${campaign}:SKU-${id}`,
    status: "draft",
    scheduledAt: "2026-09-09 13:00:00",
    publishedAt: null,
    createdAt: "2026-09-07 10:00:00",
    payload: JSON.stringify({ caption: "c", brand: "ameublo", reelsVideoUrl: "https://x/v.mp4" }),
    metadata: { style: "ugc_video", campaign },
  };
}

/** Every campaign that exists, including the ones an unfiltered page would cut off. */
const ALL_CAMPAIGNS = [
  "hiver-2026", "animaux-2026", "enfants-2026", "maison-2026", "automne-2026",
  "noel-2026", "halloween-2026", "patio-ete-2026",
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  db.getSequentialAdQueueItems.mockResolvedValue([row(1, "automne-2026")]);
  db.getSequentialAdCampaigns.mockResolvedValue(ALL_CAMPAIGNS);
  db.countSequentialAdQueueItems.mockResolvedValue(134);
});

describe("GET /api/sequential-ads/queue — campaign filter", () => {
  it("passes no campaign through when none is asked for", async () => {
    await GET(req());
    expect(db.getSequentialAdQueueItems).toHaveBeenCalledWith(undefined, null);
    expect(db.countSequentialAdQueueItems).toHaveBeenCalledWith(null);
  });

  it("forwards the campaign to SQL rather than filtering in the browser", async () => {
    await GET(req("?campaign=automne-2026"));
    expect(db.getSequentialAdQueueItems).toHaveBeenCalledWith(undefined, "automne-2026");
    expect(db.countSequentialAdQueueItems).toHaveBeenCalledWith("automne-2026");
  });

  it("treats campaign=all as no filter", async () => {
    await GET(req("?campaign=all"));
    expect(db.getSequentialAdQueueItems).toHaveBeenCalledWith(undefined, null);
  });

  it("treats an empty campaign as no filter", async () => {
    await GET(req("?campaign="));
    expect(db.getSequentialAdQueueItems).toHaveBeenCalledWith(undefined, null);
  });

  it("passes a campaign name with regional characters through unmangled", async () => {
    await GET(req(`?campaign=${encodeURIComponent("noël-2026")}`));
    expect(db.getSequentialAdQueueItems).toHaveBeenCalledWith(undefined, "noël-2026");
  });

  // The heart of the bug: the dropdown must offer campaigns the page cap is hiding.
  it("lists every campaign, not just those present in the returned page", async () => {
    db.getSequentialAdQueueItems.mockResolvedValue([row(1, "automne-2026")]);
    const body = await (await GET(req())).json();
    expect(body.campaigns).toEqual(ALL_CAMPAIGNS);
    expect(body.campaigns).toContain("noel-2026");
    expect(body.campaigns).toContain("patio-ete-2026");
    // Proving the point: those two appear in no returned item.
    const inPage = new Set(body.items.map((i: { campaign: string }) => i.campaign));
    expect(inPage.has("noel-2026")).toBe(false);
  });

  it("reports the true total so the UI can say it is showing a subset", async () => {
    const body = await (await GET(req())).json();
    expect(body.total).toBe(134);
    expect(body.items.length).toBeLessThan(body.total);
    expect(body.campaign).toBeNull();
  });

  it("echoes the applied campaign back", async () => {
    const body = await (await GET(req("?campaign=hiver-2026"))).json();
    expect(body.campaign).toBe("hiver-2026");
  });

  it("stays admin-only", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await GET(req())).status).toBe(403);
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await GET(req())).status).toBe(401);
  });
});
