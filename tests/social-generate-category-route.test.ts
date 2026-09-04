import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/social {action:"generate", triggerType:"stock_highlight"} with the new
 * `category` parameter from the dashboard dropdown.
 *
 * What matters here is what the OPERATOR sees: the category reaches the generator intact,
 * a typo is rejected instead of quietly generating from the whole catalog, and an empty
 * result says which category was empty (and whether the pool is simply too small) rather
 * than the old one-size-fits-all message.
 */

function genReq(extra: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "generate", triggerType: "stock_highlight", count: 3, ...extra }),
  });
}

const DRAFT = { draftId: 7, postText: "FR", postTextEn: "EN", imageUrls: ["u"] };

function mockAll(runResult: Record<string, unknown>) {
  const runStockHighlight = vi.fn().mockResolvedValue(runResult);
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(true),
    getSessionRole: vi.fn().mockResolvedValue("admin"),
  }));
  vi.doMock("@/lib/facebook-client", () => ({ testConnection: vi.fn() }));
  vi.doMock("@/lib/instagram-client", () => ({ testConnection: vi.fn() }));
  vi.doMock("@/lib/social-publisher", () => ({
    publishDraftToChannel: vi.fn(),
    publishDraftToChannels: vi.fn(),
    draftToQueueItems: vi.fn(),
  }));
  vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn() }));
  vi.doMock("@/jobs/job4-social", () => ({
    triggerNewProduct: vi.fn(),
    triggerPriceDrop: vi.fn(),
    runStockHighlight,
  }));
  vi.doMock("@/lib/database", () => ({
    getFacebookDrafts: vi.fn(),
    getFacebookDraft: vi.fn(),
    updateFacebookDraft: vi.fn(),
    deleteFacebookDraft: vi.fn(),
    setDraftChannelState: vi.fn(),
    getSetting: vi.fn(),
    addToQueue: vi.fn(),
    getOccupiedQueueSlots: vi.fn(),
    QueueSlotTakenError: class extends Error {},
  }));
  return { runStockHighlight };
}

const OK = {
  drafts: [DRAFT],
  categoryUsed: "animaux",
  categorySource: "explicit",
  fellBackToAll: false,
};

describe('POST /api/social generate — category', () => {
  beforeEach(() => vi.resetModules());

  it("forwards the chosen category and echoes what the run actually used", async () => {
    const { runStockHighlight } = mockAll(OK);
    const { POST } = await import("@/app/api/social/route");
    const res = await POST(genReq({ category: "animaux" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(runStockHighlight).toHaveBeenCalledWith(3, "animaux");
    expect(body.success).toBe(true);
    expect(body.count).toBe(1);
    expect(body.category).toBe("animaux");
    expect(body.categorySource).toBe("explicit");
    expect(body.fellBackToAll).toBe(false);
  });

  it("passes null when the dropdown is left blank, so the server picks the season", async () => {
    const { runStockHighlight } = mockAll({
      drafts: [DRAFT], categoryUsed: "halloween", categorySource: "seasonal", fellBackToAll: false,
    });
    const { POST } = await import("@/app/api/social/route");
    const res = await POST(genReq());
    expect(runStockHighlight).toHaveBeenCalledWith(3, null);
    expect((await res.json()).categorySource).toBe("seasonal");
  });

  it("reports the widening so the operator knows the posts aren't seasonal", async () => {
    mockAll({ drafts: [DRAFT], categoryUsed: null, categorySource: "seasonal", fellBackToAll: true });
    const { POST } = await import("@/app/api/social/route");
    const body = await (await POST(genReq())).json();
    expect(body.success).toBe(true);
    expect(body.fellBackToAll).toBe(true);
  });

  it("rejects an unknown category with 400 instead of generating from the whole catalog", async () => {
    const { runStockHighlight } = mockAll(OK);
    const { POST } = await import("@/app/api/social/route");
    const res = await POST(genReq({ category: "halloweeeen" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("halloweeeen");
    expect(runStockHighlight).not.toHaveBeenCalled();
  });

  it("names the category on an empty run", async () => {
    mockAll({ drafts: [], categoryUsed: "noel", categorySource: "explicit", fellBackToAll: false });
    const { POST } = await import("@/app/api/social/route");
    const res = await POST(genReq({ category: "noel" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("🎄 Noël");
  });

  it("says a category with zero validated photos is a dead end, not bad luck", async () => {
    mockAll({ drafts: [], categoryUsed: "halloween", categorySource: "explicit", fellBackToAll: false });
    const { POST } = await import("@/app/api/social/route");
    const body = await (await POST(genReq({ category: "halloween" }))).json();
    expect(body.error).toContain("🎃 Halloween");
    expect(body.error).toContain("photo lifestyle validée");
    expect(body.error).toContain("autre catégorie");
  });

  it("says a thin-but-nonzero category is worth retrying", async () => {
    mockAll({ drafts: [], categoryUsed: "rangement", categorySource: "explicit", fellBackToAll: false });
    const { POST } = await import("@/app/api/social/route");
    const body = await (await POST(genReq({ category: "rangement" }))).json();
    expect(body.error).toContain("Rangement");
    expect(body.error).toContain("Réessayez");
  });

  it("does not name 'all' as a category in the empty message", async () => {
    mockAll({ drafts: [], categoryUsed: null, categorySource: "none", fellBackToAll: false });
    const { POST } = await import("@/app/api/social/route");
    const body = await (await POST(genReq({ category: "all" }))).json();
    expect(body.error).not.toContain("«");
    expect(body.error).toContain("lifestyle-verified");
  });
});
