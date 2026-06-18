import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies POST/DELETE /api/social/drafts/:id/schedule now drive publication_queue instead of
// writing facebook_drafts status='scheduled' (the /api/cron/social-scheduled cron is retired):
//   POST   → cancel existing pending rows (re-schedule safety) + enqueue at the chosen time, draft 'approved'
//   DELETE → cancel pending rows + revert the draft to 'draft'

class QueueSlotTakenError extends Error {
  constructor(msg = "slot taken") {
    super(msg);
    this.name = "QueueSlotTakenError";
  }
}

const FUTURE_SEC = 4102444800; // 2100-01-01T00:00:00Z
const FUTURE_SQLITE = "2100-01-01 00:00:00";

const DRAFT = { id: 1, postText: "Bonjour", postTextEn: "Hello", status: "approved" };
const AMEUBLO_ITEM = { platform: "both", payload: { caption: "Bonjour", brand: "ameublo" } };

function params() {
  return { params: Promise.resolve({ id: "1" }) };
}

function postReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/social/drafts/1/schedule", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteReq() {
  return new Request("http://localhost/api/social/drafts/1/schedule", { method: "DELETE" });
}

function mockHeavyImports(queueItems: unknown[] = [AMEUBLO_ITEM]) {
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(true),
    getSessionRole: vi.fn().mockResolvedValue("admin"),
  }));
  vi.doMock("@/lib/social-publisher", () => ({
    draftToQueueItems: vi.fn().mockReturnValue(queueItems),
  }));
  vi.doMock("@/lib/config", () => ({
    activeChannels: vi.fn().mockReturnValue(["fb_ameublo"]),
  }));
}

function mockDatabase(over: Record<string, unknown> = {}) {
  const fns = {
    getFacebookDraft: vi.fn().mockResolvedValue(DRAFT),
    updateFacebookDraft: vi.fn().mockResolvedValue(undefined),
    addToQueue: vi.fn().mockResolvedValue(99),
    cancelPendingQueueItems: vi.fn().mockResolvedValue(0),
    QueueSlotTakenError,
    ...over,
  };
  vi.doMock("@/lib/database", () => fns);
  return fns;
}

describe("POST /api/social/drafts/:id/schedule → publication_queue", () => {
  beforeEach(() => vi.resetModules());

  it("cancels existing pending rows then enqueues at the chosen time, leaving the draft 'approved'", async () => {
    mockHeavyImports([AMEUBLO_ITEM]);
    const db = mockDatabase();

    const { POST } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await POST(postReq({ scheduled_at: FUTURE_SEC }), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.queued).toBe(true);
    expect(body.queuedCount).toBe(1);
    expect(body.scheduled_at).toBe(FUTURE_SEC);

    // Re-schedule safety: pending rows for this draft are dropped before the new enqueue.
    expect(db.cancelPendingQueueItems).toHaveBeenCalledWith("social", "1");
    expect(db.addToQueue).toHaveBeenCalledWith({
      contentType: "social",
      contentId: "1",
      platform: "both",
      payload: JSON.stringify(AMEUBLO_ITEM.payload),
      scheduledAt: FUTURE_SQLITE,
    });

    // Draft stays approved — no 'scheduled' state anymore.
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
    expect(db.updateFacebookDraft).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: "scheduled" }),
    );
  });

  it("skips a brand whose exact slot is already taken (QueueSlotTakenError)", async () => {
    mockHeavyImports([AMEUBLO_ITEM]);
    const addToQueue = vi.fn().mockRejectedValueOnce(new QueueSlotTakenError());
    const db = mockDatabase({ addToQueue });

    const { POST } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await POST(postReq({ scheduled_at: FUTURE_SEC }), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.queuedCount).toBe(0);
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "approved" });
  });

  it("rejects a past scheduled_at with 400 and enqueues nothing", async () => {
    mockHeavyImports();
    const db = mockDatabase();

    const { POST } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await POST(postReq({ scheduled_at: 1000 }), params());

    expect(res.status).toBe(400);
    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(db.cancelPendingQueueItems).not.toHaveBeenCalled();
  });

  it("returns 409 for a terminal/in-flight draft (e.g. published)", async () => {
    mockHeavyImports();
    const db = mockDatabase({ getFacebookDraft: vi.fn().mockResolvedValue({ ...DRAFT, status: "published" }) });

    const { POST } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await POST(postReq({ scheduled_at: FUTURE_SEC }), params());

    expect(res.status).toBe(409);
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("returns 404 when the draft does not exist", async () => {
    mockHeavyImports();
    const db = mockDatabase({ getFacebookDraft: vi.fn().mockResolvedValue(null) });

    const { POST } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await POST(postReq({ scheduled_at: FUTURE_SEC }), params());

    expect(res.status).toBe(404);
    expect(db.addToQueue).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/social/drafts/:id/schedule → cancel queued items", () => {
  beforeEach(() => vi.resetModules());

  it("cancels pending queue rows and reverts the draft to 'draft'", async () => {
    mockHeavyImports();
    const db = mockDatabase({ cancelPendingQueueItems: vi.fn().mockResolvedValue(2) });

    const { DELETE } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await DELETE(deleteReq(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("draft");
    expect(body.cancelled).toBe(2);
    expect(db.cancelPendingQueueItems).toHaveBeenCalledWith("social", "1");
    expect(db.updateFacebookDraft).toHaveBeenCalledWith(1, { status: "draft", scheduled_at: null });
  });

  it("returns 409 for a terminal/in-flight draft and cancels nothing", async () => {
    mockHeavyImports();
    const db = mockDatabase({ getFacebookDraft: vi.fn().mockResolvedValue({ ...DRAFT, status: "publishing" }) });

    const { DELETE } = await import("@/app/api/social/drafts/[id]/schedule/route");
    const res = await DELETE(deleteReq(), params());

    expect(res.status).toBe(409);
    expect(db.cancelPendingQueueItems).not.toHaveBeenCalled();
  });
});
