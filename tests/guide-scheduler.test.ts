import { describe, it, expect, vi, beforeEach } from "vitest";

const FakeQueueSlotTakenError = vi.hoisted(() => {
  return class FakeQueueSlotTakenError extends Error {
    constructor(platform: string, scheduledAt: string) {
      super(`Slot ${scheduledAt} already taken on platform '${platform}'`);
      this.name = "QueueSlotTakenError";
    }
  };
});

vi.mock("@/lib/database", () => ({
  getGuidePageById: vi.fn(),
  addToQueue: vi.fn(),
  getOccupiedQueueSlots: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn().mockResolvedValue(null),
  cancelPendingQueueItems: vi.fn().mockResolvedValue(0),
  scheduleGuidePagePublish: vi.fn().mockResolvedValue(undefined),
  clearGuidePageSchedule: vi.fn().mockResolvedValue(undefined),
  QueueSlotTakenError: FakeQueueSlotTakenError,
}));
vi.mock("@/lib/publication-scheduler", () => ({
  getNextAvailableSlot: vi.fn(),
  parseContentBatchSchedule: vi.fn().mockReturnValue({ enabled: true, slots: [], timezone: "UTC", max_per_day: 1 }),
}));

import {
  scheduleGuidePublication,
  rescheduleGuidePublication,
  cancelGuideSchedule,
} from "@/lib/guide-scheduler";
import {
  getGuidePageById,
  addToQueue,
  cancelPendingQueueItems,
  scheduleGuidePagePublish,
  clearGuidePageSchedule,
} from "@/lib/database";
import { getNextAvailableSlot } from "@/lib/publication-scheduler";
import type { GuidePageRow } from "@/lib/database";

function guideRow(overrides: Partial<GuidePageRow> = {}): GuidePageRow {
  return {
    id: 1,
    aosom_category: "Sub A",
    shopify_collection_id: "1",
    shopify_collection_title: "A",
    status: "pending_review",
    skip_reason: null,
    shopify_article_id: "art-1",
    shopify_blog_id: 7,
    shopify_handle: "guide-a",
    title: "Guide A",
    min_price: null,
    max_price: null,
    in_stock_count: null,
    body_html: "<p>x</p>",
    fact_check_score: 90,
    fact_check_issues: null,
    quality_score: 85,
    quality_reasons: null,
    overall_status: "ready",
    quality_score_before_retry: null,
    fact_check_score_before_retry: null,
    scheduled_publish_at: null,
    created_at: 0,
    ...overrides,
  };
}

const SLOT = { platform: "shopify_guide" as const, at: 1_700_000_000, iso: "2023-11-14T22:13:20.000Z", sqlite: "2023-11-14 22:13:20" };

beforeEach(() => vi.clearAllMocks());

describe("scheduleGuidePublication", () => {
  it("books the next free slot and records it on the guide row", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow());
    vi.mocked(getNextAvailableSlot).mockResolvedValue(SLOT);

    const result = await scheduleGuidePublication(1);

    expect(result).toEqual({ success: true, scheduledAt: SLOT.at, sqlite: SLOT.sqlite });
    expect(addToQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "guide",
        contentId: "1",
        platform: "shopify_guide",
        scheduledAt: SLOT.sqlite,
      }),
    );
    const payload = JSON.parse(vi.mocked(addToQueue).mock.calls[0][0].payload);
    expect(payload).toEqual({
      guidePageId: 1,
      blogId: 7,
      articleId: "art-1",
      shopifyCollectionId: "1",
      shopifyHandle: "guide-a",
    });
    expect(scheduleGuidePagePublish).toHaveBeenCalledWith(1, SLOT.sqlite);
  });

  it("404s when the guide doesn't exist", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(null);
    const result = await scheduleGuidePublication(999);
    expect(result).toEqual({ success: false, error: "Guide not found", status: 404 });
  });

  it("rejects a non-pending_review guide", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ status: "published" }));
    const result = await scheduleGuidePublication(1);
    expect(result).toMatchObject({ success: false, status: 409, error: "Wrong status: published" });
  });

  it("rejects a guide that is already scheduled", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ scheduled_publish_at: "2026-01-01 10:00:00" }));
    const result = await scheduleGuidePublication(1);
    expect(result).toMatchObject({ success: false, status: 409, error: "Guide is already scheduled" });
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("rejects a guide with no linked Shopify article", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ shopify_article_id: null }));
    const result = await scheduleGuidePublication(1);
    expect(result).toMatchObject({ success: false, status: 409, error: "Guide has no linked Shopify article" });
  });

  it("rejects a guide with no shopify_handle (needed for the collection guide-link metafield)", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ shopify_handle: null }));
    const result = await scheduleGuidePublication(1);
    expect(result).toMatchObject({ success: false, status: 409, error: "Guide has no linked Shopify article" });
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("retries past a slot collision and books the next one", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow());
    vi.mocked(getNextAvailableSlot)
      .mockResolvedValueOnce(SLOT)
      .mockResolvedValueOnce({ ...SLOT, at: SLOT.at + 3600, sqlite: "2023-11-14 23:13:20" });
    vi.mocked(addToQueue)
      .mockRejectedValueOnce(new FakeQueueSlotTakenError("shopify_guide", SLOT.sqlite))
      .mockResolvedValueOnce(42);

    const result = await scheduleGuidePublication(1);

    expect(result).toMatchObject({ success: true, sqlite: "2023-11-14 23:13:20" });
    expect(addToQueue).toHaveBeenCalledTimes(2);
  });

  it("reports no free slot when the grid is disabled/full", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow());
    vi.mocked(getNextAvailableSlot).mockResolvedValue(null);
    const result = await scheduleGuidePublication(1);
    expect(result).toMatchObject({ success: false, status: 409, error: expect.stringMatching(/créneau libre/i) });
  });
});

describe("rescheduleGuidePublication", () => {
  it("rejects a malformed scheduledAt", async () => {
    const result = await rescheduleGuidePublication(1, "2026-01-01T10:00:00Z");
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(getGuidePageById).not.toHaveBeenCalled();
  });

  it("cancels the old queue row and books the new time", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ scheduled_publish_at: "2026-01-01 10:00:00" }));

    const result = await rescheduleGuidePublication(1, "2026-01-02 11:00:00");

    expect(result).toMatchObject({ success: true, sqlite: "2026-01-02 11:00:00" });
    expect(cancelPendingQueueItems).toHaveBeenCalledWith("guide", "1");
    expect(addToQueue).toHaveBeenCalledWith(expect.objectContaining({ scheduledAt: "2026-01-02 11:00:00" }));
    expect(scheduleGuidePagePublish).toHaveBeenCalledWith(1, "2026-01-02 11:00:00");
  });

  it("rejects a guide that isn't currently scheduled", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ scheduled_publish_at: null }));
    const result = await rescheduleGuidePublication(1, "2026-01-02 11:00:00");
    expect(result).toMatchObject({ success: false, status: 409 });
  });

  it("reports a taken slot without silently shifting the time", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ scheduled_publish_at: "2026-01-01 10:00:00" }));
    vi.mocked(addToQueue).mockRejectedValueOnce(new FakeQueueSlotTakenError("shopify_guide", "2026-01-02 11:00:00"));

    const result = await rescheduleGuidePublication(1, "2026-01-02 11:00:00");

    expect(result).toMatchObject({ success: false, status: 409, error: expect.stringMatching(/déjà pris/i) });
    expect(scheduleGuidePagePublish).not.toHaveBeenCalled();
  });
});

describe("cancelGuideSchedule", () => {
  it("cancels the queue row and clears the schedule", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ scheduled_publish_at: "2026-01-01 10:00:00" }));
    const result = await cancelGuideSchedule(1);
    expect(result).toEqual({ success: true });
    expect(cancelPendingQueueItems).toHaveBeenCalledWith("guide", "1");
    expect(clearGuidePageSchedule).toHaveBeenCalledWith(1);
  });

  it("no-ops with an error when the guide isn't scheduled", async () => {
    vi.mocked(getGuidePageById).mockResolvedValue(guideRow({ scheduled_publish_at: null }));
    const result = await cancelGuideSchedule(1);
    expect(result).toMatchObject({ success: false, error: "Guide is not scheduled" });
    expect(cancelPendingQueueItems).not.toHaveBeenCalled();
  });
});
