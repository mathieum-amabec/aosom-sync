import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Sequential-ad price guard (2026-10-02): an ad whose burned price changed since the render is
 * never approved and never published — it goes back to draft, flagged for a re-render.
 */

const db = vi.hoisted(() => ({
  getProduct: vi.fn(),
  getQueueItemById: vi.fn(),
  approveSequentialAdDraft: vi.fn(),
  getOccupiedQueueSlots: vi.fn(),
  getSetting: vi.fn(),
  flagSequentialAdForRerender: vi.fn(),
}));
vi.mock("@/lib/database", () => ({ ...db, QueueSlotTakenError: class QueueSlotTakenError extends Error {} }));
vi.mock("@/lib/publication-scheduler", () => ({ getNextAvailableSlot: vi.fn(), parseVideoSchedule: vi.fn(() => ({ enabled: true })) }));

import { checkSequentialAdPrice, skuFromContentId, priceFr } from "@/lib/sequential-ad-price";
import { approveOneSequentialAd } from "@/lib/sequential-ad-approval";

const ad = (renderedPrice?: number) => ({
  id: 9,
  contentType: "sequential_ad",
  contentId: "seqad:ugc_video:automne-2026:831-194WT",
  status: "draft",
  platform: "both",
  scheduledAt: "2030-01-01 13:00:00",
  metadata: renderedPrice === undefined ? { style: "ugc_video" } : { style: "ugc_video", renderedPrice },
});

beforeEach(() => {
  Object.values(db).forEach((f) => f.mockReset());
  db.approveSequentialAdDraft.mockResolvedValue(true);
  db.getOccupiedQueueSlots.mockResolvedValue([]);
  db.flagSequentialAdForRerender.mockResolvedValue(true);
});

describe("checkSequentialAdPrice", () => {
  it("reads the sku out of the content id", () => {
    expect(skuFromContentId("seqad:hero_slides:noel-2026:830-254")).toBe("830-254");
    expect(skuFromContentId("video:abc")).toBeNull();
  });

  it("passes when the burned price is today's price", async () => {
    db.getProduct.mockResolvedValue({ price: 79.99 });
    expect((await checkSequentialAdPrice(ad(79.99))).ok).toBe(true);
  });

  it("fails with a readable reason when the price moved", async () => {
    db.getProduct.mockResolvedValue({ price: 84.99 });
    const r = await checkSequentialAdPrice(ad(79.99));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain(`${priceFr(79.99)} → ${priceFr(84.99)}`);
  });

  it("never blocks on missing data (no recorded price, unknown product)", async () => {
    expect((await checkSequentialAdPrice(ad())).ok).toBe(true);
    expect(db.getProduct).not.toHaveBeenCalled();
    db.getProduct.mockResolvedValue(null);
    expect((await checkSequentialAdPrice(ad(79.99))).ok).toBe(true);
  });
});

describe("approval refuses a stale-price ad", () => {
  it("flags it for a re-render and does not approve it", async () => {
    db.getQueueItemById.mockResolvedValue(ad(79.99));
    db.getProduct.mockResolvedValue({ price: 84.99 });
    const r = await approveOneSequentialAd(9);
    expect(r).toMatchObject({ success: false, status: 409 });
    expect(db.flagSequentialAdForRerender).toHaveBeenCalledWith(9, expect.stringContaining("À re-rendre"));
    expect(db.approveSequentialAdDraft).not.toHaveBeenCalled();
  });

  it("approves normally when the price is unchanged", async () => {
    db.getQueueItemById.mockResolvedValue(ad(79.99));
    db.getProduct.mockResolvedValue({ price: 79.99 });
    const r = await approveOneSequentialAd(9);
    expect(r.success).toBe(true);
    expect(db.flagSequentialAdForRerender).not.toHaveBeenCalled();
  });
});
