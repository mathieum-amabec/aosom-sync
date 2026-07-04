import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/slideshow/generate — builds a slideshow (Module G) and optionally enqueues it into
// publication_queue as a content_type='video' Reel. GET /api/slideshow/preview — dry-run manifest.

class QueueSlotTakenError extends Error {
  constructor(m = "slot taken") {
    super(m);
    this.name = "QueueSlotTakenError";
  }
}

const VALID_TEMPLATES = [
  "SHOWCASE", "BEST_SELLERS", "PRICE_DROP", "URGENCY", "LOOKBOOK", "DISCOVERY", "COUNTDOWN", "REMIX",
];

const SLOT = { platform: "facebook", at: 1765206000, iso: "2025-12-08T15:00:00.000Z", sqlite: "2025-12-08 15:00:00" };

const MANIFEST = {
  items: [{ image_url: "https://cdn.shopify.com/x.jpg", overlay_text: "Chaise", price: 99, showsBadge: false }],
  template: "BEST_SELLERS",
  ratio: "9:16",
  brand: "ameublo",
  language: "fr",
  music: "track.mp3",
  estimatedDurationSec: 12,
  wouldUploadTo: "slideshows/ameublo/best_sellers/9x16/1.mp4",
  dryRun: true,
};

const ITEMS = [
  { image_url: "https://cdn.shopify.com/x.jpg", overlay_text: "Chaise de bureau", price: 99, sku: "A1" },
  { image_url: "https://cdn.shopify.com/y.jpg", overlay_text: "Table basse", price: 149, sku: "B2" },
];

const postReq = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/slideshow/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getReq = (qs: string) => new Request(`http://localhost/api/slideshow/preview?${qs}`);

function mockAll(over: { build?: Record<string, unknown>; db?: Record<string, unknown>; scheduler?: Record<string, unknown>; auth?: { authenticated?: boolean; role?: string } } = {}) {
  // Auth is mocked EXACTLY ONCE here (state threaded via over.auth) so tests never
  // stack a second vi.doMock("@/lib/auth") on top — that double-registration was
  // order-dependent and leaked the admin mock into the unauth/reviewer cases on
  // full-suite runs (passed in isolation). One doMock per module = deterministic.
  const authenticated = over.auth?.authenticated ?? true;
  const role = over.auth?.role ?? "admin";
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(authenticated),
    getSessionRole: vi.fn().mockResolvedValue(role),
  }));
  vi.doMock("@/lib/config", () => ({
    VIDEO_RATIOS: ["9:16", "1:1", "16:9"],
    activeChannels: vi.fn().mockReturnValue(["fb_ameublo", "ig_ameublo"]),
    CHANNEL_META: {
      fb_ameublo: { platform: "facebook", brand: "ameublo" },
      ig_ameublo: { platform: "instagram", brand: "ameublo" },
      fb_furnish: { platform: "facebook", brand: "furnish" },
    },
  }));
  // Default buildSlideshow: a real render that returns a blob URL + items. Overridable per test.
  const buildSlideshow =
    (over.build?.buildSlideshow as ReturnType<typeof vi.fn>) ??
    vi.fn().mockResolvedValue({
      result: { blobUrl: "https://blob/slideshow.mp4", durationSec: 12 },
      items: ITEMS,
      template: "BEST_SELLERS",
      ratio: "9:16",
      brand: "ameublo",
      language: "fr",
    });
  vi.doMock("@/lib/slideshow/build", () => ({
    buildSlideshow,
    isSlideshowTemplate: (v: unknown) => typeof v === "string" && VALID_TEMPLATES.includes(v),
    languageForBrand: (brand: string) => (brand === "furnish" ? "en" : "fr"),
  }));
  vi.doMock("@/lib/publication-scheduler", () => ({
    getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT),
    parseVideoSchedule: vi.fn().mockReturnValue({ enabled: true, slots: [], timezone: "UTC", max_per_day: 2, ratio: "9:16", platform: "both" }),
    parseSlideshowSettings: vi.fn().mockReturnValue({ enabled_templates: {}, default_ratio: "9:16", platform: "both" }),
    ...over.scheduler,
  }));
  const db = {
    getSetting: vi.fn().mockResolvedValue(null),
    getOccupiedQueueSlots: vi.fn().mockResolvedValue([]),
    addToQueue: vi.fn().mockResolvedValue(42),
    cancelQueueItemsForContent: vi.fn().mockResolvedValue(0),
    QueueSlotTakenError,
    ...over.db,
  };
  vi.doMock("@/lib/database", () => db);
  return { db, buildSlideshow };
}

beforeEach(() => vi.resetModules());

describe("POST /api/slideshow/generate", () => {
  it("dryRun:true → 200 manifest, no upload, no enqueue", async () => {
    const buildSlideshow = vi.fn().mockResolvedValue({
      result: { manifest: MANIFEST, durationSec: 12 },
      items: MANIFEST.items,
      template: "BEST_SELLERS",
      ratio: "9:16",
      brand: "ameublo",
      language: "fr",
    });
    const { db } = mockAll({ build: { buildSlideshow } });
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: true, enqueue: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.manifest).toEqual(MANIFEST);
    expect(buildSlideshow).toHaveBeenCalledWith("BEST_SELLERS", expect.objectContaining({ dryRun: true }));
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("dryRun:false enqueue:true → renders and enqueues a DRAFT awaiting approval", async () => {
    const { db, buildSlideshow } = mockAll();
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: false, enqueue: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe("draft"); // awaits operator approval, not yet publishable
    expect(json.blobUrl).toBe("https://blob/slideshow.mp4");
    expect(json.queueId).toBe(42);
    expect(json.platform).toBe("both");
    expect(buildSlideshow).toHaveBeenCalledWith("BEST_SELLERS", expect.objectContaining({ dryRun: false }));
    expect(db.addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "video", platform: "both", scheduledAt: SLOT.sqlite, status: "draft" }),
    );
    const payload = JSON.parse((db.addToQueue as ReturnType<typeof vi.fn>).mock.calls[0][0].payload);
    expect(payload.reelsVideoUrl).toBe("https://blob/slideshow.mp4");
    expect(payload.brand).toBe("ameublo");
    expect(payload.caption).toContain("Chaise de bureau"); // caption carries product material for clickbait
    // Re-queue safety: deterministic contentId (no Date.now()) + cancel prior pending/draft rows.
    const contentId = (db.addToQueue as ReturnType<typeof vi.fn>).mock.calls[0][0].contentId;
    expect(contentId).toBe("slideshow:BEST_SELLERS:9:16");
    expect(db.cancelQueueItemsForContent).toHaveBeenCalledWith("video", "slideshow:BEST_SELLERS:9:16");
  });

  it("400 (not 500) when buildSlideshow rejects on a real render (no eligible products)", async () => {
    const buildSlideshow = vi.fn().mockRejectedValue(new Error("buildSlideshow: no eligible products for template BEST_SELLERS"));
    const { db } = mockAll({ build: { buildSlideshow } });
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: false, enqueue: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no eligible products/);
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("400 on an invalid ratio in opts", async () => {
    mockAll();
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: true, opts: { ratio: "4:5" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ratio/i);
  });

  it("400 on an invalid brand in opts", async () => {
    mockAll();
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: true, opts: { brand: "furnsh" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/brand/i);
  });

  it("dryRun:false enqueue:false → renders, returns blobUrl, no queue row", async () => {
    const { db } = mockAll();
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: false, enqueue: false }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.blobUrl).toBe("https://blob/slideshow.mp4");
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("409 when no free slot is available (rendered but not queued)", async () => {
    // Drafts don't reserve a slot, but generation still needs a tentative slot to
    // display; with the schedule full/disabled there's none, so it 409s after rendering.
    const getNextAvailableSlot = vi.fn().mockResolvedValue(null);
    const { db } = mockAll({ scheduler: { getNextAvailableSlot } });
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: false, enqueue: true }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.blobUrl).toBe("https://blob/slideshow.mp4"); // rendered, just not queued
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("400 on an invalid template", async () => {
    mockAll();
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "NOPE", dryRun: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/template/i);
  });

  it("401 when unauthenticated", async () => {
    mockAll({ auth: { authenticated: false } });
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: true }));
    expect(res.status).toBe(401);
  });

  it("403 for reviewers", async () => {
    mockAll({ auth: { role: "reviewer" } });
    const { POST } = await import("@/app/api/slideshow/generate/route");
    const res = await POST(postReq({ template: "BEST_SELLERS", dryRun: true }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/slideshow/preview", () => {
  it("returns a dry-run manifest for the requested template", async () => {
    const buildSlideshow = vi.fn().mockResolvedValue({
      result: { manifest: MANIFEST, durationSec: 12 },
      items: MANIFEST.items,
      template: "BEST_SELLERS",
      ratio: "9:16",
      brand: "ameublo",
      language: "fr",
    });
    mockAll({ build: { buildSlideshow } });
    const { GET } = await import("@/app/api/slideshow/preview/route");
    const res = await GET(getReq("template=BEST_SELLERS&ratio=9:16&brand=ameublo&language=fr"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.manifest).toEqual(MANIFEST);
    expect(buildSlideshow).toHaveBeenCalledWith("BEST_SELLERS", expect.objectContaining({ dryRun: true, ratio: "9:16" }));
  });

  it("400 on an invalid template", async () => {
    mockAll();
    const { GET } = await import("@/app/api/slideshow/preview/route");
    const res = await GET(getReq("template=NOPE"));
    expect(res.status).toBe(400);
  });

  it("401 when unauthenticated", async () => {
    mockAll({ auth: { authenticated: false } });
    const { GET } = await import("@/app/api/slideshow/preview/route");
    const res = await GET(getReq("template=BEST_SELLERS"));
    expect(res.status).toBe(401);
  });

  it("403 for reviewers (read-only, blocked like generate)", async () => {
    mockAll({ auth: { role: "reviewer" } });
    const { GET } = await import("@/app/api/slideshow/preview/route");
    const res = await GET(getReq("template=BEST_SELLERS"));
    expect(res.status).toBe(403);
  });

  it("400 on an invalid ratio query param", async () => {
    mockAll();
    const { GET } = await import("@/app/api/slideshow/preview/route");
    const res = await GET(getReq("template=BEST_SELLERS&ratio=4:5"));
    expect(res.status).toBe(400);
  });
});
