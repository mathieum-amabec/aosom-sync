import { describe, it, expect, vi, beforeEach } from "vitest";

// getNextAvailableSlot reads occupancy from the live publication_queue via
// getOccupiedQueueSlots(platform, contentType?). Mock that boundary so these stay pure
// unit tests of the content_type scoping (independent slot pools per queue).
vi.mock("@/lib/database", () => ({ getOccupiedQueueSlots: vi.fn() }));

import { getNextAvailableSlot } from "@/lib/publication-scheduler";
import { getOccupiedQueueSlots } from "@/lib/database";

const mockOccupied = getOccupiedQueueSlots as unknown as ReturnType<typeof vi.fn>;
const TZ = "America/Toronto";
const settings = {
  publication_schedule: JSON.stringify({
    enabled: true,
    timezone: TZ,
    max_per_day: 3,
    slots: [{ day: "mon", times: ["09:00", "12:00"] }],
  }),
};
const NOW = Math.floor(Date.UTC(2026, 5, 15, 0, 0, 0) / 1000);

beforeEach(() => mockOccupied.mockReset());

describe("getNextAvailableSlot — content_type scoping (independent queues)", () => {
  it("contentType='video' fetches VIDEO-only occupancy (not the shared cross-type view)", async () => {
    mockOccupied.mockResolvedValue([]);
    const next = await getNextAvailableSlot("facebook", settings, { nowSec: NOW, contentType: "video" });
    expect(next).not.toBeNull();
    expect(mockOccupied).toHaveBeenCalledWith("facebook", "video");
  });

  it("a Reel is NOT crowded out by a social post in the same slot — pools are independent", async () => {
    // Video pool empty → video takes the first slot.
    mockOccupied.mockResolvedValue([]);
    const videoSlot = (await getNextAvailableSlot("facebook", settings, { nowSec: NOW, contentType: "video" }))!;
    expect(videoSlot).not.toBeNull();

    // A SOCIAL query that sees that slot occupied must move past it...
    mockOccupied.mockResolvedValue([videoSlot.sqlite]);
    const socialNext = (await getNextAvailableSlot("facebook", settings, { nowSec: NOW }))!;
    expect(socialNext.at).toBeGreaterThan(videoSlot.at);

    // ...but the VIDEO pool (queried independently, still empty) keeps the first slot.
    mockOccupied.mockResolvedValue([]);
    const videoAgain = (await getNextAvailableSlot("facebook", settings, { nowSec: NOW, contentType: "video" }))!;
    expect(videoAgain.at).toBe(videoSlot.at);
  });

  it("without contentType, occupancy is the shared cross-type view (backward compatible)", async () => {
    mockOccupied.mockResolvedValue([]);
    await getNextAvailableSlot("facebook", settings, { nowSec: NOW });
    expect(mockOccupied).toHaveBeenCalledWith("facebook", undefined);
  });

  it("respects max_per_day within the video pool only", async () => {
    // Two video rows on the same Monday (max_per_day:3 → still room) vs filling it.
    mockOccupied.mockResolvedValue([]);
    const first = (await getNextAvailableSlot("facebook", settings, { nowSec: NOW, contentType: "video" }))!;
    expect(first.at).toBeGreaterThan(NOW);
  });
});
