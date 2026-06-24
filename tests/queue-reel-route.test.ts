import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/social/queue-reel — enqueues a demand-gen video (video_demand_gen) into
// publication_queue as a Reel (reelsVideoUrl) on the next free slot.

class QueueSlotTakenError extends Error {
  constructor(m = "slot taken") {
    super(m);
    this.name = "QueueSlotTakenError";
  }
}

const ASSETS = [
  { sku: "824-051V80BK", ratio: "9:16", durationSec: 6, blobUrl: "https://blob/6.mp4", titleFr: "Ventilateur tour", shopifyProductId: "gid://1" },
  { sku: "824-051V80BK", ratio: "9:16", durationSec: 30, blobUrl: "https://blob/30.mp4", titleFr: "Ventilateur tour", shopifyProductId: "gid://1" },
  { sku: "824-051V80BK", ratio: "16:9", durationSec: 15, blobUrl: "https://blob/169.mp4", titleFr: "Ventilateur tour", shopifyProductId: "gid://1" },
];
const SLOT = { platform: "facebook", at: 1765206000, iso: "2025-12-08T15:00:00.000Z", sqlite: "2025-12-08 15:00:00" };

const req = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/social/queue-reel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function mockAll(
  dbOver: Record<string, unknown> = {},
  schedulerOver: Record<string, unknown> = {},
) {
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(true),
    getSessionRole: vi.fn().mockResolvedValue("admin"),
  }));
  vi.doMock("@/lib/config", () => ({
    activeChannels: vi.fn().mockReturnValue(["fb_ameublo", "ig_ameublo", "fb_furnish"]),
    CHANNEL_META: {
      fb_ameublo: { platform: "facebook", brand: "ameublo" },
      ig_ameublo: { platform: "instagram", brand: "ameublo" },
      fb_furnish: { platform: "facebook", brand: "furnish" },
      ig_furnish: { platform: "instagram", brand: "furnish" },
    },
  }));
  vi.doMock("@/lib/publication-scheduler", () => ({
    getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT),
    parseVideoSchedule: vi.fn().mockReturnValue({ enabled: true, slots: [], timezone: "America/Toronto", max_per_day: 2 }),
    ...schedulerOver,
  }));
  const db = {
    getDemandGenAssets: vi.fn().mockResolvedValue(ASSETS),
    getSetting: vi.fn().mockResolvedValue('{"enabled":true}'),
    getOccupiedQueueSlots: vi.fn().mockResolvedValue([]),
    addToQueue: vi.fn().mockResolvedValue(42),
    cancelPendingQueueItems: vi.fn().mockResolvedValue(0),
    QueueSlotTakenError,
    ...dbOver,
  };
  vi.doMock("@/lib/database", () => db);
  return db;
}

beforeEach(() => vi.resetModules());

describe("POST /api/social/queue-reel", () => {
  it("enqueues the longest 9:16 cut as a reel on 'both' for fr/ameublo", async () => {
    const db = mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "9:16", language: "fr" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.platform).toBe("both");
    expect(json.durationSec).toBe(30); // longest cut chosen by default
    expect(db.addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "video", platform: "both", scheduledAt: SLOT.sqlite }),
    );
    const payload = JSON.parse((db.addToQueue as ReturnType<typeof vi.fn>).mock.calls[0][0].payload);
    expect(payload).toEqual({ caption: "Ventilateur tour", brand: "ameublo", reelsVideoUrl: "https://blob/30.mp4" });
    // re-queue safety: prior pending rows for this exact reel are cancelled first (content_type='video')
    expect(db.cancelPendingQueueItems).toHaveBeenCalledWith("video", "reel:824-051V80BK:9:16:30");
  });

  it("honours explicit duration_sec", async () => {
    const db = mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "9:16", language: "fr", duration_sec: 6 }));
    const json = await res.json();
    expect(json.durationSec).toBe(6);
    expect(JSON.parse((db.addToQueue as ReturnType<typeof vi.fn>).mock.calls[0][0].payload).reelsVideoUrl).toBe("https://blob/6.mp4");
  });

  it("en → furnish brand, platform facebook (ig_furnish inactive), with explicit caption", async () => {
    mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "9:16", language: "en", caption: "Tower fan" }));
    const json = await res.json();
    expect(json.brand).toBe("furnish");
    expect(json.platform).toBe("facebook");
  });

  it("400 for en without a caption (no FR caption on the EN brand)", async () => {
    mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "9:16", language: "en" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/caption.*required.*English/i);
  });

  it("400 for a non-9:16 ratio (reels are vertical)", async () => {
    mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "16:9", language: "fr" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/9:16/);
  });

  it("404 when no asset for sku/ratio", async () => {
    mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "NOPE", ratio: "9:16", language: "fr" }));
    expect(res.status).toBe(404);
  });

  it("400 on invalid ratio", async () => {
    mockAll();
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "4:5", language: "fr" }));
    expect(res.status).toBe(400);
  });

  it("retries past a slot taken by another platform race", async () => {
    const SLOT2 = { ...SLOT, at: 1765292400, sqlite: "2025-12-09 15:00:00" };
    const addToQueue = vi.fn().mockRejectedValueOnce(new QueueSlotTakenError()).mockResolvedValueOnce(43);
    const getNextAvailableSlot = vi.fn().mockResolvedValueOnce(SLOT).mockResolvedValueOnce(SLOT2);
    // Route the scheduler override THROUGH mockAll so publication-scheduler is doMock'd
    // exactly once — a second vi.doMock of the same module raced nondeterministically.
    mockAll({ addToQueue }, { getNextAvailableSlot });
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "9:16", language: "fr" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.slot).toBe(SLOT2.sqlite);
    expect(getNextAvailableSlot).toHaveBeenCalledTimes(2);
  });

  it("401 when unauthenticated", async () => {
    mockAll();
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false), getSessionRole: vi.fn() }));
    const { POST } = await import("@/app/api/social/queue-reel/route");
    const res = await POST(req({ sku: "824-051V80BK", ratio: "9:16", language: "fr" }));
    expect(res.status).toBe(401);
  });
});
