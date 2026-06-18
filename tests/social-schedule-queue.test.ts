import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies POST /api/social {action:"schedule"} now enqueues into publication_queue at the
// operator-chosen time (one item per brand via draftToQueueItems + addToQueue) and leaves the
// draft 'approved' in facebook_drafts — it no longer writes a 'scheduled' facebook_draft for the
// retired /api/cron/social-scheduled cron.

class QueueSlotTakenError extends Error {
  constructor(msg = "slot taken") {
    super(msg);
    this.name = "QueueSlotTakenError";
  }
}

// 2100-01-01T00:00:00Z — a fixed far-future slot so the "must be in the future" guard always passes
// and the unix→SQLite conversion is deterministic.
const FUTURE_SEC = 4102444800;
const FUTURE_SQLITE = "2100-01-01 00:00:00";

function scheduleReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "schedule", ...body }),
  });
}

const DRAFT = { id: 1, postText: "Bonjour", postTextEn: "Hello", status: "draft" };
const AMEUBLO_ITEM = { platform: "both", payload: { caption: "Bonjour", brand: "ameublo" } };
const FURNISH_ITEM = { platform: "facebook", payload: { caption: "Hello", brand: "furnish" } };

function mockHeavyImports(queueItems: unknown[] = [AMEUBLO_ITEM]) {
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(true),
    getSessionRole: vi.fn().mockResolvedValue("admin"),
  }));
  vi.doMock("@/lib/facebook-client", () => ({ testConnection: vi.fn() }));
  vi.doMock("@/lib/instagram-client", () => ({ testConnection: vi.fn() }));
  vi.doMock("@/lib/social-publisher", () => ({
    publishDraftToChannel: vi.fn(),
    publishDraftToChannels: vi.fn(),
    draftToQueueItems: vi.fn().mockReturnValue(queueItems),
  }));
  vi.doMock("@/jobs/job4-social", () => ({
    triggerNewProduct: vi.fn(),
    triggerPriceDrop: vi.fn(),
    triggerStockHighlight: vi.fn(),
  }));
  // schedule doesn't call getNextAvailableSlot, but the route imports it — keep the module light.
  vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn() }));
}

function mockDatabase(over: Record<string, unknown> = {}) {
  const fns = {
    getFacebookDrafts: vi.fn(),
    getFacebookDraft: vi.fn().mockResolvedValue(DRAFT),
    updateFacebookDraft: vi.fn().mockResolvedValue(undefined),
    deleteFacebookDraft: vi.fn(),
    setDraftChannelState: vi.fn(),
    getSetting: vi.fn().mockResolvedValue('{"enabled":true}'),
    addToQueue: vi.fn().mockResolvedValue(99),
    getOccupiedQueueSlots: vi.fn().mockResolvedValue([]),
    QueueSlotTakenError,
    ...over,
  };
  vi.doMock("@/lib/database", () => fns);
  return fns;
}

describe('POST /api/social action="schedule" → publication_queue', () => {
  beforeEach(() => vi.resetModules());

  it("enqueues the mapped per-brand payload at the operator-chosen slot and keeps the draft 'approved'", async () => {
    mockHeavyImports([AMEUBLO_ITEM]);
    const db = mockDatabase();

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(scheduleReq({ id: 1, scheduledAt: FUTURE_SEC }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(true);
    expect(body.queuedCount).toBe(1);
    // Response echoes the operator's unix-seconds choice (dashboard contract), not the SQLite text.
    expect(body.scheduledAt).toBe(FUTURE_SEC);

    // Enqueues the MAPPED payload at the chosen time converted to SQLite-datetime text.
    expect(db.addToQueue).toHaveBeenCalledWith({
      contentType: "social",
      contentId: "1",
      platform: "both",
      payload: JSON.stringify(AMEUBLO_ITEM.payload),
      scheduledAt: FUTURE_SQLITE,
    });

    // Draft stays approved — it is NOT written as a scheduled facebook_draft anymore.
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
    expect(db.updateFacebookDraft).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "scheduled" }),
    );
  });

  it("enqueues one item per brand (bilingual draft → ameublo + furnish) at the same chosen slot", async () => {
    mockHeavyImports([AMEUBLO_ITEM, FURNISH_ITEM]);
    const db = mockDatabase();

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(scheduleReq({ id: 1, scheduledAt: FUTURE_SEC }));
    const body = await res.json();

    expect(body.queuedCount).toBe(2);
    expect(db.addToQueue).toHaveBeenCalledTimes(2);
    expect(db.addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "both", scheduledAt: FUTURE_SQLITE }),
    );
    expect(db.addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "facebook", scheduledAt: FUTURE_SQLITE }),
    );
  });

  it("skips a brand whose slot is already taken (QueueSlotTakenError), still approves", async () => {
    mockHeavyImports([AMEUBLO_ITEM, FURNISH_ITEM]);
    const addToQueue = vi
      .fn()
      .mockRejectedValueOnce(new QueueSlotTakenError()) // ameublo slot collides
      .mockResolvedValueOnce(100); // furnish enqueues
    const db = mockDatabase({ addToQueue });

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(scheduleReq({ id: 1, scheduledAt: FUTURE_SEC }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queuedCount).toBe(1); // only furnish made it in
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
  });

  it("rejects a missing or past scheduledAt with 400 and enqueues nothing", async () => {
    mockHeavyImports();
    const db = mockDatabase();

    const { POST } = await import("@/app/api/social/route");

    const pastRes = await POST(scheduleReq({ id: 1, scheduledAt: 1000 }));
    expect(pastRes.status).toBe(400);

    const missingRes = await POST(scheduleReq({ id: 1 }));
    expect(missingRes.status).toBe(400);

    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(db.updateFacebookDraft).not.toHaveBeenCalled();
  });

  it("returns 404 when the draft does not exist", async () => {
    mockHeavyImports();
    const db = mockDatabase({ getFacebookDraft: vi.fn().mockResolvedValue(null) });

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(scheduleReq({ id: 1, scheduledAt: FUTURE_SEC }));

    expect(res.status).toBe(404);
    expect(db.addToQueue).not.toHaveBeenCalled();
  });
});
