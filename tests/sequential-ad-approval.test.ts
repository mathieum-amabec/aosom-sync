import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getQueueItemById: vi.fn(),
  approveSequentialAdDraft: vi.fn(),
  getOccupiedQueueSlots: vi.fn(),
  getSetting: vi.fn(),
}));
vi.mock("@/lib/database", () => ({
  ...db,
  QueueSlotTakenError: class QueueSlotTakenError extends Error {},
}));
const sched = vi.hoisted(() => ({ getNextAvailableSlot: vi.fn(), parseVideoSchedule: vi.fn(() => ({ enabled: true })) }));
vi.mock("@/lib/publication-scheduler", () => sched);

import { approveOneSequentialAd } from "@/lib/sequential-ad-approval";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const row = (scheduledAt: string) => ({ id: 7, contentType: "sequential_ad", status: "draft", platform: "facebook", scheduledAt });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.values(db).forEach((f) => f.mockReset());
  sched.getNextAvailableSlot.mockReset();
  db.approveSequentialAdDraft.mockResolvedValue(true);
  db.getOccupiedQueueSlots.mockResolvedValue([]);
  db.getSetting.mockResolvedValue(null);
});

describe("approveOneSequentialAd — slot picked at generation", () => {
  it("keeps the generation-time slot while it is still in the future", async () => {
    db.getQueueItemById.mockResolvedValue(row("2026-10-05 13:00:00"));
    const r = await approveOneSequentialAd(7);
    expect(db.approveSequentialAdDraft).toHaveBeenCalledWith(7, "2026-10-05 13:00:00");
    expect(sched.getNextAvailableSlot).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it("never keeps a PAST slot (a September draft approved in October) — books the next free one instead", async () => {
    db.getQueueItemById.mockResolvedValue(row("2026-09-09 13:00:00"));
    sched.getNextAvailableSlot.mockResolvedValue({ at: Date.parse("2026-10-02T13:00:00Z") / 1000, sqlite: "2026-10-02 13:00:00" });
    const r = await approveOneSequentialAd(7);
    expect(db.approveSequentialAdDraft).not.toHaveBeenCalledWith(7, "2026-09-09 13:00:00");
    expect(db.approveSequentialAdDraft).toHaveBeenCalledWith(7, "2026-10-02 13:00:00");
    expect(sched.getNextAvailableSlot.mock.calls[0][2].nowSec).toBe(NOW / 1000);
    expect(r).toMatchObject({ success: true, scheduledAt: Date.parse("2026-10-02T13:00:00Z") / 1000 });
  });
});
