import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies the /drafts-page approveDraft() server action now auto-enqueues EVERY approved draft
// (regardless of triggerType) into publication_queue (one item per brand via draftToQueueItems +
// addToQueue) on the next free publication_schedule slot, leaving the draft 'approved' — it no
// longer writes facebook_drafts.status='scheduled' for the retired social-scheduled cron. Mirrors
// the /api/social {action:"approve"} path.

class QueueSlotTakenError extends Error {
  constructor(msg = "slot taken") {
    super(msg);
    this.name = "QueueSlotTakenError";
  }
}

const CT_DRAFT = { id: 1, triggerType: "content_template", postText: "Bonjour", postTextEn: "Hello", status: "draft" };
const AMEUBLO_ITEM = { platform: "both", payload: { caption: "Bonjour", brand: "ameublo" } };
const FURNISH_ITEM = { platform: "facebook", payload: { caption: "Hello", brand: "furnish" } };

const SLOT = { platform: "facebook" as const, at: 1765206000, iso: "2025-12-08T15:00:00.000Z", sqlite: "2025-12-08 15:00:00" };
const SLOT2 = { ...SLOT, at: 1765378800, sqlite: "2025-12-10 15:00:00" };

function mockCommon() {
  vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
  vi.doMock("@/lib/facebook-client", () => ({ publishText: vi.fn() }));
  vi.doMock("@/lib/config", () => ({ activeChannels: vi.fn().mockReturnValue(["fb_ameublo", "fb_furnish"]) }));
}

function mockDatabase(over: Record<string, unknown> = {}) {
  const fns = {
    approveDraftDb: vi.fn().mockResolvedValue(undefined),
    rejectDraftDb: vi.fn(),
    getFacebookDraft: vi.fn().mockResolvedValue(CT_DRAFT),
    updateFacebookDraft: vi.fn().mockResolvedValue(undefined),
    getSetting: vi.fn().mockResolvedValue('{"enabled":true}'),
    addToQueue: vi.fn().mockResolvedValue(99),
    getOccupiedQueueSlots: vi.fn().mockResolvedValue([]),
    QueueSlotTakenError,
    ...over,
  };
  vi.doMock("@/lib/database", () => fns);
  return fns;
}

describe("approveDraft() → publication_queue (all draft types auto-schedule)", () => {
  beforeEach(() => vi.resetModules());

  it("enqueues the mapped per-brand payload at the next slot and keeps the draft approved", async () => {
    mockCommon();
    const db = mockDatabase();
    vi.doMock("@/lib/social-publisher", () => ({ draftToQueueItems: vi.fn().mockReturnValue([AMEUBLO_ITEM]) }));
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT) }));

    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);

    expect(db.approveDraftDb).toHaveBeenCalledWith(1);
    expect(db.addToQueue).toHaveBeenCalledWith({
      contentType: "social",
      contentId: "1",
      platform: "both",
      payload: JSON.stringify(AMEUBLO_ITEM.payload),
      scheduledAt: SLOT.sqlite,
    });
    // Draft is NOT written as a scheduled facebook_draft (approveDraftDb already set 'approved').
    expect(db.updateFacebookDraft).not.toHaveBeenCalledWith(1, expect.objectContaining({ status: "scheduled" }));
    expect(result.scheduledAt).toBe(SLOT.at);
  });

  it("enqueues one item per brand (bilingual) and returns the earliest slot", async () => {
    mockCommon();
    const db = mockDatabase();
    vi.doMock("@/lib/social-publisher", () => ({
      draftToQueueItems: vi.fn().mockReturnValue([AMEUBLO_ITEM, FURNISH_ITEM]),
    }));
    vi.doMock("@/lib/publication-scheduler", () => ({
      getNextAvailableSlot: vi.fn().mockResolvedValueOnce(SLOT).mockResolvedValueOnce(SLOT2),
    }));

    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);

    expect(db.addToQueue).toHaveBeenCalledTimes(2);
    // Occupancy is now scoped to the 'social' queue (independent slot pool).
    expect(db.getOccupiedQueueSlots).toHaveBeenCalledWith("both", "social");
    expect(db.getOccupiedQueueSlots).toHaveBeenCalledWith("facebook", "social");
    expect(result.scheduledAt).toBe(SLOT.at); // earliest of the two
  });

  it("does NOT enqueue when the publication schedule is disabled (no slot), still approves", async () => {
    mockCommon();
    const db = mockDatabase();
    vi.doMock("@/lib/social-publisher", () => ({ draftToQueueItems: vi.fn().mockReturnValue([AMEUBLO_ITEM]) }));
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn().mockResolvedValue(null) }));

    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);

    expect(db.approveDraftDb).toHaveBeenCalledWith(1);
    expect(db.addToQueue).not.toHaveBeenCalled();
    expect(result).toEqual({}); // no scheduledAt — draft stays approved, unscheduled
  });

  it("auto-enqueues non-content_template drafts (e.g. new_product) too", async () => {
    mockCommon();
    const db = mockDatabase({ getFacebookDraft: vi.fn().mockResolvedValue({ ...CT_DRAFT, triggerType: "new_product" }) });
    const draftToQueueItems = vi.fn().mockReturnValue([AMEUBLO_ITEM]);
    vi.doMock("@/lib/social-publisher", () => ({ draftToQueueItems }));
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT) }));

    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);

    expect(db.approveDraftDb).toHaveBeenCalledWith(1);
    expect(draftToQueueItems).toHaveBeenCalled(); // gate removed — trigger type no longer matters
    expect(db.addToQueue).toHaveBeenCalledWith({
      contentType: "social",
      contentId: "1",
      platform: "both",
      payload: JSON.stringify(AMEUBLO_ITEM.payload),
      scheduledAt: SLOT.sqlite,
    });
    expect(result.scheduledAt).toBe(SLOT.at);
  });

  it("retries past a slot lost to QueueSlotTakenError", async () => {
    mockCommon();
    const addToQueue = vi.fn().mockRejectedValueOnce(new QueueSlotTakenError()).mockResolvedValueOnce(100);
    const db = mockDatabase({ addToQueue });
    vi.doMock("@/lib/social-publisher", () => ({ draftToQueueItems: vi.fn().mockReturnValue([AMEUBLO_ITEM]) }));
    const getNextAvailableSlot = vi.fn().mockResolvedValueOnce(SLOT).mockResolvedValueOnce(SLOT2);
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot }));

    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);

    expect(getNextAvailableSlot).toHaveBeenCalledTimes(2);
    expect(getNextAvailableSlot.mock.calls[1][2].occupied).toContain(SLOT.at);
    expect(result.scheduledAt).toBe(SLOT2.at);
  });

  it("swallows an unexpected enqueue error (best-effort) and still reports success", async () => {
    mockCommon();
    const db = mockDatabase({ addToQueue: vi.fn().mockRejectedValue(new Error("DB down")) });
    vi.doMock("@/lib/social-publisher", () => ({ draftToQueueItems: vi.fn().mockReturnValue([AMEUBLO_ITEM]) }));
    vi.doMock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT) }));

    const { approveDraft } = await import("@/app/(dashboard)/drafts/actions");
    const result = await approveDraft(1);

    expect(db.approveDraftDb).toHaveBeenCalledWith(1); // approval not undone
    expect(result).toEqual({}); // enqueue failure swallowed, no error surfaced
  });
});
