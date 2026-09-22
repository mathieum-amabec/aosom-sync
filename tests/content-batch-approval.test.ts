import { describe, it, expect, vi, beforeEach } from "vitest";

// approveOneContentBatchDraft (content-batch-approval.ts) — the demand_gen_ext / before_after /
// assembly equivalent of approveOneSequentialAd: auto-assigns a draft to the next free slot on
// its OWN format's recurring grid (not a shared video_schedule), retrying past a slot lost to
// QueueSlotTakenError. Mirrors approve-draft-queue.test.ts's mocking convention.

class QueueSlotTakenError extends Error {
  constructor(msg = "slot taken") {
    super(msg);
    this.name = "QueueSlotTakenError";
  }
}

const ROW = {
  id: 5,
  contentType: "demand_gen_ext",
  contentId: "839-281",
  platform: "facebook",
  payload: "{}",
  scheduledAt: "2026-12-31 09:00:00",
  status: "draft",
  error: null,
  createdAt: "2026-09-21 00:00:00",
  publishedAt: null,
  metadata: null,
};

const SLOT = { platform: "facebook" as const, at: 1765206000, iso: "2025-12-08T15:00:00.000Z", sqlite: "2025-12-08 15:00:00" };
const SLOT2 = { ...SLOT, at: 1765378800, sqlite: "2025-12-10 15:00:00" };

function mockDatabase(over: Record<string, unknown> = {}) {
  const fns = {
    getQueueItemById: vi.fn().mockResolvedValue(ROW),
    approveContentBatchDraft: vi.fn().mockResolvedValue(true),
    getOccupiedQueueSlots: vi.fn().mockResolvedValue([]),
    getSetting: vi.fn().mockResolvedValue(null),
    QueueSlotTakenError,
    ...over,
  };
  vi.doMock("@/lib/database", () => fns);
  return fns;
}

function mockScheduler(over: Record<string, unknown> = {}) {
  const fns = {
    getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT),
    parseContentBatchSchedule: vi.fn().mockReturnValue({ enabled: true, slots: [], timezone: "America/Toronto", max_per_day: 1 }),
    CONTENT_BATCH_SCHEDULE_SETTING_KEY: {
      demand_gen_ext: "demand_gen_ext_schedule",
      before_after: "before_after_schedule",
      assembly: "assembly_schedule",
    },
    ...over,
  };
  vi.doMock("@/lib/publication-scheduler", () => fns);
  return fns;
}

describe("approveOneContentBatchDraft", () => {
  beforeEach(() => vi.resetModules());

  it("approves a draft at the next free grid slot for its format", async () => {
    const db = mockDatabase();
    const sched = mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(result).toEqual({ success: true, queueId: 5, scheduledAt: SLOT.at, sqlite: SLOT.sqlite });
    expect(db.approveContentBatchDraft).toHaveBeenCalledWith(5, "demand_gen_ext", SLOT.sqlite);
    expect(sched.getNextAvailableSlot.mock.calls[0][2].contentType).toBe("demand_gen_ext");
  });

  it("reads the FORMAT'S OWN schedule setting, not another format's", async () => {
    const db = mockDatabase({ getQueueItemById: vi.fn().mockResolvedValue({ ...ROW, contentType: "before_after" }) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    await approveOneContentBatchDraft(5, "before_after");

    expect(db.getSetting).toHaveBeenCalledWith("before_after_schedule");
    expect(db.getSetting).not.toHaveBeenCalledWith("demand_gen_ext_schedule");
    expect(db.getSetting).not.toHaveBeenCalledWith("assembly_schedule");
  });

  it("scopes occupancy to its own content_type's queue", async () => {
    const db = mockDatabase({ getQueueItemById: vi.fn().mockResolvedValue({ ...ROW, contentType: "assembly" }) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    await approveOneContentBatchDraft(5, "assembly");

    expect(db.getOccupiedQueueSlots).toHaveBeenCalledWith("facebook", "assembly");
  });

  it("404s when no queue item matches that id", async () => {
    mockDatabase({ getQueueItemById: vi.fn().mockResolvedValue(null) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(999, "demand_gen_ext");

    expect(result).toEqual({ success: false, queueId: 999, error: "No matching draft with that id/contentType", status: 404 });
  });

  it("404s when the id belongs to a DIFFERENT content_type", async () => {
    mockDatabase({ getQueueItemById: vi.fn().mockResolvedValue({ ...ROW, contentType: "before_after" }) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(result.success).toBe(false);
    if (!result.success) expect(result.status).toBe(404);
  });

  it("refuses a non-draft row (already pending/published/cancelled)", async () => {
    mockDatabase({ getQueueItemById: vi.fn().mockResolvedValue({ ...ROW, status: "pending" }) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(result).toEqual({
      success: false,
      queueId: 5,
      error: "Item 5 is not an approvable draft (status: pending)",
      status: 400,
    });
  });

  it("returns a 409 when the grid has no free slot (disabled or full)", async () => {
    mockDatabase();
    mockScheduler({ getNextAvailableSlot: vi.fn().mockResolvedValue(null) });

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/créneau/i);
    }
  });

  it("retries past a slot lost to QueueSlotTakenError, carrying it forward as occupied", async () => {
    const db = mockDatabase({
      approveContentBatchDraft: vi.fn().mockRejectedValueOnce(new QueueSlotTakenError()).mockResolvedValueOnce(true),
    });
    const sched = mockScheduler({
      getNextAvailableSlot: vi.fn().mockResolvedValueOnce(SLOT).mockResolvedValueOnce(SLOT2),
    });

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(sched.getNextAvailableSlot).toHaveBeenCalledTimes(2);
    expect(sched.getNextAvailableSlot.mock.calls[1][2].occupied).toContain(SLOT.at);
    expect(db.approveContentBatchDraft).toHaveBeenNthCalledWith(1, 5, "demand_gen_ext", SLOT.sqlite);
    expect(db.approveContentBatchDraft).toHaveBeenNthCalledWith(2, 5, "demand_gen_ext", SLOT2.sqlite);
    expect(result).toEqual({ success: true, queueId: 5, scheduledAt: SLOT2.at, sqlite: SLOT2.sqlite });
  });

  it("gives up after 6 attempts, all lost to QueueSlotTakenError", async () => {
    const db = mockDatabase({ approveContentBatchDraft: vi.fn().mockRejectedValue(new QueueSlotTakenError()) });
    mockScheduler({ getNextAvailableSlot: vi.fn().mockResolvedValue(SLOT) });

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(db.approveContentBatchDraft).toHaveBeenCalledTimes(6);
    expect(result).toEqual({
      success: false,
      queueId: 5,
      error: "Could not secure a free slot after retries",
      status: 409,
    });
  });

  it("reports a 409 when the row changed status underneath (approve returns false, not an error)", async () => {
    mockDatabase({ approveContentBatchDraft: vi.fn().mockResolvedValue(false) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    const result = await approveOneContentBatchDraft(5, "demand_gen_ext");

    expect(result).toEqual({
      success: false,
      queueId: 5,
      error: "Draft was already approved or cancelled",
      status: 409,
    });
  });

  it("propagates an unexpected error rather than swallowing it", async () => {
    mockDatabase({ approveContentBatchDraft: vi.fn().mockRejectedValue(new Error("DB down")) });
    mockScheduler();

    const { approveOneContentBatchDraft } = await import("@/lib/content-batch-approval");
    await expect(approveOneContentBatchDraft(5, "demand_gen_ext")).rejects.toThrow("DB down");
  });
});
