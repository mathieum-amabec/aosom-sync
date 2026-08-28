import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  toLocalInputValue,
  earliestSlotValue,
  initialSlotValue,
} from "@/app/(dashboard)/sequential-ads/sequential-ads-client";

/* ── mocks ──────────────────────────────────────────────────────────────────── */

const auth = { isAuthenticated: vi.fn(), getSessionRole: vi.fn() };
vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => auth.isAuthenticated(),
  getSessionRole: () => auth.getSessionRole(),
}));

class QueueSlotTakenError extends Error {
  constructor(kind: string, slot: string) {
    super(`slot taken: ${kind} ${slot}`);
    this.name = "QueueSlotTakenError";
  }
}
const db = {
  getQueueItemById: vi.fn(),
  claimQueueItem: vi.fn(),
  markPublished: vi.fn(),
  markFailed: vi.fn(),
  rescheduleSequentialAd: vi.fn(),
};
vi.mock("@/lib/database", () => ({
  getQueueItemById: (...a: unknown[]) => db.getQueueItemById(...a),
  claimQueueItem: (...a: unknown[]) => db.claimQueueItem(...a),
  markPublished: (...a: unknown[]) => db.markPublished(...a),
  markFailed: (...a: unknown[]) => db.markFailed(...a),
  rescheduleSequentialAd: (...a: unknown[]) => db.rescheduleSequentialAd(...a),
  QueueSlotTakenError,
}));

const publisher = { publishQueueItem: vi.fn() };
vi.mock("@/lib/queue-publisher", () => ({
  publishQueueItem: (...a: unknown[]) => publisher.publishQueueItem(...a),
}));

const { POST: publishNow } = await import("@/app/api/sequential-ads/publish-now/route");
const { POST: schedule } = await import("@/app/api/sequential-ads/schedule/route");

const req = (body: unknown) =>
  new Request("http://localhost/api/sequential-ads/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ITEM = { id: 7, contentType: "sequential_ad", status: "pending", platform: "facebook" };
/** Well clear of any clock skew between the test and the route's Date.now(). */
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  db.getQueueItemById.mockResolvedValue({ ...ITEM });
  db.claimQueueItem.mockResolvedValue(true);
  db.rescheduleSequentialAd.mockResolvedValue(true);
  publisher.publishQueueItem.mockResolvedValue({ postId: "fb_123" });
});

/* ── publish-now ────────────────────────────────────────────────────────────── */

describe("POST /api/sequential-ads/publish-now", () => {
  it("claims, publishes, and marks published", async () => {
    const res = await publishNow(req({ queueId: 7 }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, queueId: 7, postId: "fb_123" });
    expect(db.claimQueueItem).toHaveBeenCalledWith(7);
    expect(db.markPublished).toHaveBeenCalledWith(7);
    expect(db.markFailed).not.toHaveBeenCalled();
  });

  it("claims BEFORE publishing, so the cron cannot double-publish", async () => {
    const order: string[] = [];
    db.claimQueueItem.mockImplementation(async () => { order.push("claim"); return true; });
    publisher.publishQueueItem.mockImplementation(async () => { order.push("publish"); return { postId: "x" }; });
    await publishNow(req({ queueId: 7 }));
    expect(order).toEqual(["claim", "publish"]);
  });

  it("409s without publishing when the scheduler already claimed the row", async () => {
    db.claimQueueItem.mockResolvedValue(false);
    const res = await publishNow(req({ queueId: 7 }));
    expect(res.status).toBe(409);
    expect(publisher.publishQueueItem).not.toHaveBeenCalled();
    expect(db.markFailed).not.toHaveBeenCalled();
  });

  it("marks the row failed when publishing throws, never leaving it stuck in 'publishing'", async () => {
    publisher.publishQueueItem.mockRejectedValue(new Error("Graph API 400"));
    const res = await publishNow(req({ queueId: 7 }));
    expect(res.status).toBe(502);
    expect(db.markFailed).toHaveBeenCalledWith(7, "Graph API 400");
    expect(db.markPublished).not.toHaveBeenCalled();
  });

  it("refuses a draft and points at approval instead of silently approving it", async () => {
    db.getQueueItemById.mockResolvedValue({ ...ITEM, status: "draft" });
    const res = await publishNow(req({ queueId: 7 }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/Approve/i) });
    expect(db.claimQueueItem).not.toHaveBeenCalled();
  });

  it("refuses an already-published item", async () => {
    db.getQueueItemById.mockResolvedValue({ ...ITEM, status: "published" });
    expect((await publishNow(req({ queueId: 7 }))).status).toBe(400);
    expect(db.claimQueueItem).not.toHaveBeenCalled();
  });

  it("404s on a queue row that is not a sequential ad", async () => {
    db.getQueueItemById.mockResolvedValue({ ...ITEM, contentType: "video" });
    expect((await publishNow(req({ queueId: 7 }))).status).toBe(404);
  });

  it("rejects a missing or non-numeric queueId", async () => {
    expect((await publishNow(req({}))).status).toBe(400);
    expect((await publishNow(req({ queueId: "abc" }))).status).toBe(400);
    expect((await publishNow(req({ queueId: -1 }))).status).toBe(400);
  });

  it("is admin-only", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    expect((await publishNow(req({ queueId: 7 }))).status).toBe(401);
    auth.isAuthenticated.mockResolvedValue(true);
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await publishNow(req({ queueId: 7 }))).status).toBe(403);
    expect(publisher.publishQueueItem).not.toHaveBeenCalled();
  });
});

/* ── schedule ───────────────────────────────────────────────────────────────── */

describe("POST /api/sequential-ads/schedule", () => {
  it("converts an ISO instant to the queue's SQLite UTC format", async () => {
    const res = await schedule(req({ queueId: 7, scheduledAt: "2099-03-04T18:30:00.000Z" }));
    expect(res.status).toBe(200);
    expect(db.rescheduleSequentialAd).toHaveBeenCalledWith(7, "2099-03-04 18:30:00");
  });

  it("normalises a non-UTC offset to UTC — a Montreal 14:00 is not an 14:00 slot", async () => {
    await schedule(req({ queueId: 7, scheduledAt: "2099-07-04T14:00:00-04:00" }));
    expect(db.rescheduleSequentialAd).toHaveBeenCalledWith(7, "2099-07-04 18:00:00");
  });

  it("schedules a draft (approve at a chosen time)", async () => {
    db.getQueueItemById.mockResolvedValue({ ...ITEM, status: "draft" });
    expect((await schedule(req({ queueId: 7, scheduledAt: FUTURE }))).status).toBe(200);
  });

  it("rejects a past datetime and names the publish-now route", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await schedule(req({ queueId: 7, scheduledAt: past }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/Publier maintenant/) });
    expect(db.rescheduleSequentialAd).not.toHaveBeenCalled();
  });

  it("surfaces a taken slot as 409 instead of silently moving the ad", async () => {
    db.rescheduleSequentialAd.mockRejectedValue(new QueueSlotTakenError("sequential_ad", "x"));
    const res = await schedule(req({ queueId: 7, scheduledAt: FUTURE }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/créneau/i) });
  });

  it("refuses to reschedule a terminal or in-flight row", async () => {
    for (const status of ["publishing", "published", "failed", "cancelled"]) {
      db.getQueueItemById.mockResolvedValue({ ...ITEM, status });
      expect((await schedule(req({ queueId: 7, scheduledAt: FUTURE }))).status).toBe(400);
    }
    expect(db.rescheduleSequentialAd).not.toHaveBeenCalled();
  });

  it("rejects a malformed datetime", async () => {
    expect((await schedule(req({ queueId: 7, scheduledAt: "pas une date" }))).status).toBe(400);
    expect((await schedule(req({ queueId: 7 }))).status).toBe(400);
  });

  it("is admin-only", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    expect((await schedule(req({ queueId: 7, scheduledAt: FUTURE }))).status).toBe(403);
  });
});

/* ── UI helper ──────────────────────────────────────────────────────────────── */

describe("toLocalInputValue", () => {
  it("renders the operator's LOCAL wall-clock time, not UTC", () => {
    const out = toLocalInputValue("2026-08-20 18:00:00");
    const d = new Date("2026-08-20T18:00:00Z");
    const p = (n: number) => String(n).padStart(2, "0");
    expect(out).toBe(
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`,
    );
  });

  it("round-trips back to the same instant the queue stored", () => {
    const iso = new Date(toLocalInputValue("2026-08-20 18:00:00")).toISOString();
    expect(iso.slice(0, 19)).toBe("2026-08-20T18:00:00");
  });

  it("returns an empty string on garbage rather than 'NaN-NaN-NaN'", () => {
    expect(toLocalInputValue("not-a-date")).toBe("");
  });
});

describe("earliestSlotValue", () => {
  it("is exactly 24h ahead of now, in local wall-clock form", () => {
    const now = new Date("2026-09-01T15:30:00Z");
    expect(earliestSlotValue(now)).toBe(
      toLocalInputValue("2026-09-02 15:30:00"),
    );
  });

  it("crosses a month boundary without producing a day 32", () => {
    const out = earliestSlotValue(new Date("2026-08-31T12:00:00Z"));
    expect(out).toBe(toLocalInputValue("2026-09-01 12:00:00"));
  });
});

describe("initialSlotValue", () => {
  // The bug this guards: the July patio batch is still in `draft` carrying slots from
  // 2026-07-08..07-17, so the picker opened on a date the server already refuses.
  const now = new Date("2026-09-01T15:30:00Z");

  it("does NOT open on a stale July slot — it falls forward to the 24h floor", () => {
    expect(initialSlotValue("2026-07-08 22:00:00", now)).toBe(earliestSlotValue(now));
  });

  it("keeps a slot that is still comfortably in the future", () => {
    const future = "2026-10-15 13:00:00";
    expect(initialSlotValue(future, now)).toBe(toLocalInputValue(future));
  });

  it("falls forward for a slot inside the next 24h, since the server would refuse it", () => {
    expect(initialSlotValue("2026-09-01 18:00:00", now)).toBe(earliestSlotValue(now));
  });

  it("falls forward on an unparseable stored slot instead of emptying the input", () => {
    expect(initialSlotValue("not-a-date", now)).toBe(earliestSlotValue(now));
  });

  it("never returns a value in the past, whatever the row holds", () => {
    for (const stored of ["2026-07-08 22:00:00", "2026-01-01 00:00:00", "", "garbage"]) {
      expect(initialSlotValue(stored, now) >= earliestSlotValue(now)).toBe(true);
    }
  });
});
