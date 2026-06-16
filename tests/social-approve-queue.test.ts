import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies POST /api/social {action:"approve"} now enqueues into publication_queue
// (one item per brand via draftToQueueItems + addToQueue) and leaves the draft
// 'approved' in facebook_drafts — it no longer writes a 'scheduled' facebook_draft.

class QueueSlotTakenError extends Error {
  constructor(msg = "slot taken") {
    super(msg);
    this.name = "QueueSlotTakenError";
  }
}

function approveReq(id: unknown = 1) {
  return new Request("http://localhost/api/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve", id }),
  });
}

const DRAFT = { id: 1, postText: "Bonjour", postTextEn: "Hello", status: "draft" };
// One mapped queue item (ameublo/FR on both FB+IG) — what draftToQueueItems would return.
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

const SLOT = {
  platform: "facebook" as const,
  at: 1765206000,
  iso: "2025-12-08T15:00:00.000Z",
  sqlite: "2025-12-08 15:00:00",
};

describe('POST /api/social action="approve" → publication_queue', () => {
  beforeEach(() => vi.resetModules());

  it("enqueues a mapped per-brand payload at the next schedule slot and keeps the draft 'approved'", async () => {
    mockHeavyImports([AMEUBLO_ITEM]);
    const db = mockDatabase();
    const getNextAvailableSlot = vi.fn().mockResolvedValue(SLOT);
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot }));

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(approveReq(1));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(true);
    expect(body.queuedCount).toBe(1);
    // Response exposes unix seconds (the dashboard's contract), NOT the SQLite string.
    expect(body.scheduledAt).toBe(SLOT.at);

    expect(db.getSetting).toHaveBeenCalledWith("publication_schedule");
    // Enqueues the MAPPED payload (caption + brand), not the raw draft, with the SQLite slot.
    expect(db.addToQueue).toHaveBeenCalledWith({
      contentType: "social",
      contentId: "1",
      platform: "both",
      payload: JSON.stringify(AMEUBLO_ITEM.payload),
      scheduledAt: "2025-12-08 15:00:00",
    });

    // Draft stays approved — NOT written as a scheduled facebook_draft.
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
    expect(db.updateFacebookDraft).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "scheduled" }),
    );
  });

  it("enqueues one item per brand (bilingual draft → ameublo + furnish)", async () => {
    mockHeavyImports([AMEUBLO_ITEM, FURNISH_ITEM]);
    const db = mockDatabase();
    vi.doMock("@/lib/publication-scheduler", () => ({
      getNextAvailableSlot: vi
        .fn()
        .mockResolvedValueOnce(SLOT)
        .mockResolvedValueOnce({ ...SLOT, at: 1765378800, sqlite: "2025-12-10 15:00:00" }),
    }));

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(approveReq(1));
    const body = await res.json();

    expect(body.queuedCount).toBe(2);
    expect(db.addToQueue).toHaveBeenCalledTimes(2);
    expect(db.getOccupiedQueueSlots).toHaveBeenCalledWith("both");
    expect(db.getOccupiedQueueSlots).toHaveBeenCalledWith("facebook");
    // scheduledAt is the EARLIEST of the two booked slots.
    expect(body.scheduledAt).toBe(SLOT.at);
  });

  it("falls back to plain 'approved' (no queue entry) when no slot is available", async () => {
    mockHeavyImports([AMEUBLO_ITEM]);
    const db = mockDatabase();
    vi.doMock("@/lib/publication-scheduler", () => ({
      getNextAvailableSlot: vi.fn().mockResolvedValue(null),
    }));

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(approveReq(1));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.queuedCount).toBe(0);
    expect(body.scheduledAt).toBeUndefined();
    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
  });

  it("retries past a slot lost to QueueSlotTakenError", async () => {
    mockHeavyImports([AMEUBLO_ITEM]);
    const addToQueue = vi
      .fn()
      .mockRejectedValueOnce(new QueueSlotTakenError())
      .mockResolvedValueOnce(100);
    const db = mockDatabase({ addToQueue });
    const getNextAvailableSlot = vi
      .fn()
      .mockResolvedValueOnce(SLOT)
      .mockResolvedValueOnce({ ...SLOT, at: 1765378800, sqlite: "2025-12-10 15:00:00" });
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot }));

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(approveReq(1));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(getNextAvailableSlot).toHaveBeenCalledTimes(2);
    // The taken slot's unix-sec is fed back as occupied on the retry.
    expect(getNextAvailableSlot.mock.calls[1][2].occupied).toContain(SLOT.at);
    expect(body.scheduledAt).toBe(1765378800);
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
  });

  it("returns 404 when the draft does not exist", async () => {
    mockHeavyImports();
    const db = mockDatabase({ getFacebookDraft: vi.fn().mockResolvedValue(null) });
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn() }));

    const { POST } = await import("@/app/api/social/route");
    const res = await POST(approveReq(1));
    expect(res.status).toBe(404);
    expect(db.addToQueue).not.toHaveBeenCalled();
  });
});
