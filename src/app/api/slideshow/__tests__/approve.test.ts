import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Mock auth + database + scheduler so the routes run without libsql/network.
const auth = vi.hoisted(() => ({ isAuthenticated: vi.fn(), getSessionRole: vi.fn() }));
const db = vi.hoisted(() => {
  class QueueSlotTakenError extends Error {
    constructor(platform: string, scheduledAt: string) {
      super(`Slot ${scheduledAt} taken on ${platform}`);
      this.name = "QueueSlotTakenError";
    }
  }
  return {
    QueueSlotTakenError,
    getQueueItemById: vi.fn(),
    approveVideoDraft: vi.fn(),
    cancelVideoDraft: vi.fn(),
    getOccupiedQueueSlots: vi.fn(),
    getSetting: vi.fn(),
    getVideoQueueItems: vi.fn(),
  };
});
const sched = vi.hoisted(() => ({ getNextAvailableSlot: vi.fn(), parseVideoSchedule: vi.fn() }));

vi.mock("@/lib/auth", () => auth);
vi.mock("@/lib/database", () => db);
vi.mock("@/lib/publication-scheduler", () => sched);

import { POST, DELETE } from "@/app/api/slideshow/approve/route";
import { GET as queueGET } from "@/app/api/slideshow/queue/route";

function postReq(body: unknown, method: "POST" | "DELETE" = "POST"): Request {
  return new Request("https://app.test/api/slideshow/approve", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated.mockResolvedValue(true);
  auth.getSessionRole.mockResolvedValue("admin");
  db.getOccupiedQueueSlots.mockResolvedValue([]);
  db.getSetting.mockResolvedValue(null);
  sched.parseVideoSchedule.mockReturnValue({});
});

describe("POST /api/slideshow/approve", () => {
  it("flips a valid draft to pending and returns scheduledAt", async () => {
    db.getQueueItemById.mockResolvedValue({
      id: 7, contentType: "video", status: "draft", platform: "both", scheduledAt: "2026-07-01 10:00:00",
    });
    db.approveVideoDraft.mockResolvedValue(true);

    const res = await POST(postReq({ queueId: 7 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    // Approved on the draft's own (still-free) slot.
    expect(db.approveVideoDraft).toHaveBeenCalledWith(7, "2026-07-01 10:00:00");
    expect(typeof body.scheduledAt).toBe("number");
  });

  it("recomputes a free slot when the draft's slot is taken", async () => {
    db.getQueueItemById.mockResolvedValue({
      id: 8, contentType: "video", status: "draft", platform: "both", scheduledAt: "2026-07-01 10:00:00",
    });
    // First attempt (draft slot) collides; second attempt (recomputed) succeeds.
    db.approveVideoDraft
      .mockRejectedValueOnce(new db.QueueSlotTakenError("both", "2026-07-01 10:00:00"))
      .mockResolvedValueOnce(true);
    sched.getNextAvailableSlot.mockResolvedValue({ at: 1_780_000_000, sqlite: "2026-07-01 11:00:00" });

    const res = await POST(postReq({ queueId: 8 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scheduledAt).toBe(1_780_000_000);
    expect(db.approveVideoDraft).toHaveBeenLastCalledWith(8, "2026-07-01 11:00:00");
  });

  it("rejects a non-draft item with 400", async () => {
    db.getQueueItemById.mockResolvedValue({
      id: 9, contentType: "video", status: "pending", platform: "both", scheduledAt: "2026-07-01 10:00:00",
    });
    const res = await POST(postReq({ queueId: 9 }));
    expect(res.status).toBe(400);
    expect(db.approveVideoDraft).not.toHaveBeenCalled();
  });

  it("404s when the item doesn't exist", async () => {
    db.getQueueItemById.mockResolvedValue(null);
    const res = await POST(postReq({ queueId: 999 }));
    expect(res.status).toBe(404);
  });

  it("401 without auth", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await POST(postReq({ queueId: 7 }));
    expect(res.status).toBe(401);
  });

  it("403 for a reviewer", async () => {
    auth.getSessionRole.mockResolvedValue("reviewer");
    const res = await POST(postReq({ queueId: 7 }));
    expect(res.status).toBe(403);
  });

  it("400 on a missing/invalid queueId", async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/slideshow/approve", () => {
  it("cancels a draft", async () => {
    db.cancelVideoDraft.mockResolvedValue(true);
    const res = await DELETE(postReq({ queueId: 7 }, "DELETE"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(db.cancelVideoDraft).toHaveBeenCalledWith(7);
  });

  it("404 when there's no draft to cancel", async () => {
    db.cancelVideoDraft.mockResolvedValue(false);
    const res = await DELETE(postReq({ queueId: 7 }, "DELETE"));
    expect(res.status).toBe(404);
  });

  it("401 without auth", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await DELETE(postReq({ queueId: 7 }, "DELETE"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/slideshow/queue", () => {
  it("returns mapped video items with their statuses", async () => {
    db.getVideoQueueItems.mockResolvedValue([
      { id: 1, contentType: "video", contentId: "slideshow:BEST_SELLERS:9:16", platform: "both", payload: JSON.stringify({ reelsVideoUrl: "https://cdn/x.mp4", caption: "Hi", brand: "ameublo" }), scheduledAt: "2026-07-01 10:00:00", status: "draft", error: null, createdAt: "2026-06-27 09:00:00", publishedAt: null },
      { id: 2, contentType: "video", contentId: "slideshow:PRICE_DROP:1:1", platform: "facebook", payload: "not json", scheduledAt: "2026-07-02 10:00:00", status: "pending", error: null, createdAt: "2026-06-27 08:00:00", publishedAt: null },
    ]);
    const res = await queueGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ id: 1, status: "draft", payload: { reelsVideoUrl: "https://cdn/x.mp4", brand: "ameublo" } });
    expect(body.items[1].status).toBe("pending");
    expect(body.items[1].payload).toEqual({}); // malformed payload → empty, never throws
  });

  it("401 without auth", async () => {
    auth.isAuthenticated.mockResolvedValue(false);
    const res = await queueGET();
    expect(res.status).toBe(401);
  });
});

// ─── Direct SQL: prove the draft transition + slot invariants ────────────────
describe("publication_queue draft SQL (direct)", () => {
  let conn: Client;
  beforeEach(async () => {
    conn = createClient({ url: ":memory:" });
    await conn.batch([
      `CREATE TABLE publication_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_type TEXT NOT NULL CHECK (content_type IN ('social','draft','blog','video')),
        content_id TEXT NOT NULL, platform TEXT NOT NULL, payload TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending','publishing','published','failed','cancelled','draft')),
        error TEXT, created_at TEXT DEFAULT (datetime('now')), published_at TEXT
      )`,
      `CREATE UNIQUE INDEX idx_active_slot ON publication_queue(platform, scheduled_at) WHERE status IN ('pending','publishing','published')`,
    ]);
  });

  it("accepts status='draft' and the approve UPDATE flips draft → pending", async () => {
    await conn.execute(`INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status) VALUES ('video','c1','both','{}','2026-07-01 10:00:00','draft')`);
    const upd = await conn.execute(`UPDATE publication_queue SET status='pending', scheduled_at='2026-07-01 10:00:00' WHERE id=1 AND status='draft' AND content_type='video'`);
    expect(upd.rowsAffected).toBe(1);
    const row = await conn.execute(`SELECT status FROM publication_queue WHERE id=1`);
    expect(String((row.rows[0] as unknown as Record<string, unknown>).status)).toBe("pending");
  });

  it("does NOT reserve a slot for drafts (two drafts can share a slot) but enforces one active per slot on approval", async () => {
    // Two drafts at the same (platform, slot) — allowed because drafts are outside the partial index.
    await conn.execute(`INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status) VALUES ('video','a','both','{}','2026-07-01 10:00:00','draft')`);
    await conn.execute(`INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status) VALUES ('video','b','both','{}','2026-07-01 10:00:00','draft')`);
    // Approving the first is fine.
    await conn.execute(`UPDATE publication_queue SET status='pending' WHERE id=1 AND status='draft'`);
    // Approving the second onto the same slot violates the active-slot unique index.
    await expect(
      conn.execute(`UPDATE publication_queue SET status='pending' WHERE id=2 AND status='draft'`),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
    conn.close();
  });
});
