import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = { isAuthenticated: vi.fn(), getSessionRole: vi.fn() };
vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => auth.isAuthenticated(),
  getSessionRole: () => auth.getSessionRole(),
}));

const db = { getQueueItemById: vi.fn() };
vi.mock("@/lib/database", () => ({
  getQueueItemById: (...a: unknown[]) => db.getQueueItemById(...a),
}));

const approval = { approveOneSequentialAd: vi.fn() };
vi.mock("@/lib/sequential-ad-approval", () => ({
  approveOneSequentialAd: (...a: unknown[]) => approval.approveOneSequentialAd(...a),
}));

const guard = { checkSequentialAdQuality: vi.fn() };
vi.mock("@/lib/sequential-ad-guard", () => ({
  checkSequentialAdQuality: (...a: unknown[]) => guard.checkSequentialAdQuality(...a),
}));

const { POST: bulkApprove } = await import("@/app/api/sequential-ads/bulk-approve/route");

const req = (body: unknown) =>
  new Request("http://localhost/api/sequential-ads/bulk-approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const draftRow = (id: number, contentId = `seqad:hero_slides:patio-ete-2026:SKU-${id}`) => ({
  id,
  contentType: "sequential_ad",
  status: "draft",
  contentId,
  payload: JSON.stringify({ caption: "Chaise longue", reelsVideoUrl: "https://example.com/v.mp4" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  guard.checkSequentialAdQuality.mockResolvedValue({ passes: true, reasons: [] });
  approval.approveOneSequentialAd.mockImplementation(async (id: number) => ({
    success: true,
    queueId: id,
    scheduledAt: 1_800_000_000,
  }));
});

describe("POST /api/sequential-ads/bulk-approve", () => {
  it("approves every id that passes the quality gate", async () => {
    db.getQueueItemById.mockImplementation(async (id: number) => draftRow(id));
    const res = await bulkApprove(req({ queueIds: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toHaveLength(3);
    expect(body.skipped).toHaveLength(0);
    expect(approval.approveOneSequentialAd).toHaveBeenCalledTimes(3);
  });

  it("skips an id that fails the quality gate WITHOUT approving it", async () => {
    db.getQueueItemById.mockImplementation(async (id: number) => draftRow(id));
    guard.checkSequentialAdQuality.mockImplementation(async (input: { contentId: string }) =>
      input.contentId.endsWith("SKU-2")
        ? { passes: false, reasons: ["product SKU-2 is now out of stock"] }
        : { passes: true, reasons: [] },
    );
    const res = await bulkApprove(req({ queueIds: [1, 2, 3] }));
    const body = await res.json();
    expect(body.approved.map((a: { id: number }) => a.id)).toEqual([1, 3]);
    expect(body.skipped).toEqual([{ id: 2, reasons: ["product SKU-2 is now out of stock"] }]);
    expect(approval.approveOneSequentialAd).toHaveBeenCalledTimes(2);
    expect(approval.approveOneSequentialAd).not.toHaveBeenCalledWith(2);
  });

  it("skips (does not call the quality gate for) a row that is not a draft", async () => {
    db.getQueueItemById.mockResolvedValue({ ...draftRow(5), status: "pending" });
    const res = await bulkApprove(req({ queueIds: [5] }));
    const body = await res.json();
    expect(body.skipped).toEqual([{ id: 5, reasons: ["not a draft (status: pending)"] }]);
    expect(guard.checkSequentialAdQuality).not.toHaveBeenCalled();
    expect(approval.approveOneSequentialAd).not.toHaveBeenCalled();
  });

  it("skips a row that is not a sequential ad", async () => {
    db.getQueueItemById.mockResolvedValue({ ...draftRow(6), contentType: "video" });
    const res = await bulkApprove(req({ queueIds: [6] }));
    const body = await res.json();
    expect(body.skipped[0].reasons[0]).toMatch(/no sequential-ad queue item/);
  });

  it("skips an id that does not exist", async () => {
    db.getQueueItemById.mockResolvedValue(null);
    const res = await bulkApprove(req({ queueIds: [999] }));
    const body = await res.json();
    expect(body.skipped[0].id).toBe(999);
  });

  it("surfaces an approval failure (e.g. no free slot) as skipped, not a thrown error", async () => {
    db.getQueueItemById.mockImplementation(async (id: number) => draftRow(id));
    approval.approveOneSequentialAd.mockResolvedValue({
      success: false,
      queueId: 1,
      error: "No free publication slot (schedule disabled or full)",
      status: 409,
    });
    const res = await bulkApprove(req({ queueIds: [1] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toEqual([{ id: 1, reasons: ["No free publication slot (schedule disabled or full)"] }]);
  });

  it("never approves anything not explicitly listed in queueIds", async () => {
    db.getQueueItemById.mockImplementation(async (id: number) => draftRow(id));
    await bulkApprove(req({ queueIds: [42] }));
    expect(approval.approveOneSequentialAd).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("rejects a missing, empty, or malformed queueIds", async () => {
    expect((await bulkApprove(req({}))).status).toBe(400);
    expect((await bulkApprove(req({ queueIds: [] }))).status).toBe(400);
    expect((await bulkApprove(req({ queueIds: ["abc"] }))).status).toBe(400);
    expect((await bulkApprove(req({ queueIds: [-1] }))).status).toBe(400);
  });

  it("rejects a batch larger than the cap without approving anything", async () => {
    const res = await bulkApprove(req({ queueIds: Array.from({ length: 151 }, (_, i) => i + 1) }));
    expect(res.status).toBe(400);
    expect(approval.approveOneSequentialAd).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await bulkApprove(req({ queueIds: [1] }))).status).toBe(401);
    auth.isAuthenticated.mockResolvedValue(true);
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await bulkApprove(req({ queueIds: [1] }))).status).toBe(403);
    expect(approval.approveOneSequentialAd).not.toHaveBeenCalled();
  });
});
