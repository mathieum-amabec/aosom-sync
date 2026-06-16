import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// These exercise the publication_queue SQL semantics (getNextPending / markPublished /
// markFailed / getOccupiedQueueSlots) against a fresh in-memory libsql DB. The exported
// database.ts helpers bind a process-singleton client, so — like database.test.ts — we
// replicate the table DDL and run the same statements directly. Keeping the DDL in lockstep
// with initSchema is the contract under test.

// Kept byte-for-byte in lockstep with initSchema's publication_queue DDL (database.ts).
const TABLE_DDL = `CREATE TABLE IF NOT EXISTS publication_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_type TEXT NOT NULL CHECK (content_type IN ('social', 'draft', 'blog')),
  content_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'both', 'shopify_blog')),
  payload TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'cancelled')),
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  published_at TEXT
)`;
const ACTIVE_SLOT_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_queue_active_slot ON publication_queue(platform, scheduled_at) WHERE status IN ('pending', 'publishing', 'published')`;

async function setupTestDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.execute(TABLE_DDL);
  await db.execute(ACTIVE_SLOT_INDEX);
  return db;
}

async function insert(
  db: Client,
  row: {
    content_type?: string;
    content_id?: string;
    platform?: string;
    payload?: string;
    scheduled_at: string;
    status?: string;
  },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      row.content_type ?? "social",
      row.content_id ?? "src-1",
      row.platform ?? "facebook",
      row.payload ?? "{}",
      row.scheduled_at,
      row.status ?? "pending",
    ],
  });
}

describe("publication_queue — getNextPending semantics", () => {
  let db: Client;
  beforeEach(async () => {
    db = await setupTestDb();
  });
  afterEach(() => db.close());

  // Mirrors getNextPending(): due pending items, oldest slot first, capped at `limit`.
  const getNextPending = (limit = 10) =>
    db.execute({
      sql: `SELECT * FROM publication_queue
            WHERE status = 'pending' AND scheduled_at <= datetime('now')
            ORDER BY scheduled_at ASC
            LIMIT ?`,
      args: [limit],
    });

  it("returns only pending items whose slot is at/before now", async () => {
    await insert(db, { content_id: "due", scheduled_at: "2020-01-01 00:00:00" });
    await insert(db, { content_id: "future", scheduled_at: "2999-01-01 00:00:00" });
    const r = await getNextPending();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].content_id).toBe("due");
  });

  it("excludes published, failed, and cancelled items even when due", async () => {
    // Distinct slots: the partial unique index forbids two active rows in one slot.
    await insert(db, { content_id: "p", scheduled_at: "2020-01-01 00:00:00", status: "published" });
    await insert(db, { content_id: "f", scheduled_at: "2020-01-02 00:00:00", status: "failed" });
    await insert(db, { content_id: "c", scheduled_at: "2020-01-03 00:00:00", status: "cancelled" });
    await insert(db, { content_id: "ok", scheduled_at: "2020-01-04 00:00:00", status: "pending" });
    const r = await getNextPending();
    expect(r.rows.map((row) => row.content_id)).toEqual(["ok"]);
  });

  it("orders by scheduled_at ascending (oldest slot first)", async () => {
    await insert(db, { content_id: "newer", scheduled_at: "2020-03-01 00:00:00" });
    await insert(db, { content_id: "older", scheduled_at: "2020-01-01 00:00:00" });
    await insert(db, { content_id: "middle", scheduled_at: "2020-02-01 00:00:00" });
    const r = await getNextPending();
    expect(r.rows.map((row) => row.content_id)).toEqual(["older", "middle", "newer"]);
  });

  it("honors the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await insert(db, { content_id: `i${i}`, scheduled_at: `2020-01-0${i + 1} 00:00:00` });
    }
    const r = await getNextPending(2);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.map((row) => row.content_id)).toEqual(["i0", "i1"]);
  });
});

describe("publication_queue — mark transitions", () => {
  let db: Client;
  beforeEach(async () => {
    db = await setupTestDb();
  });
  afterEach(() => db.close());

  it("markPublished sets status, stamps published_at, clears error", async () => {
    await insert(db, { content_id: "x", scheduled_at: "2020-01-01 00:00:00", status: "failed" });
    await db.execute({ sql: `UPDATE publication_queue SET error = 'boom' WHERE content_id = 'x'`, args: [] });
    await db.execute({
      sql: `UPDATE publication_queue SET status = 'published', published_at = datetime('now'), error = NULL WHERE id = ?`,
      args: [1],
    });
    const r = await db.execute(`SELECT status, error, published_at FROM publication_queue WHERE id = 1`);
    expect(r.rows[0].status).toBe("published");
    expect(r.rows[0].error).toBeNull();
    expect(r.rows[0].published_at).not.toBeNull();
  });

  it("markFailed sets status and records the error", async () => {
    await insert(db, { content_id: "x", scheduled_at: "2020-01-01 00:00:00" });
    await db.execute({
      sql: `UPDATE publication_queue SET status = 'failed', error = ? WHERE id = ?`,
      args: ["network timeout", 1],
    });
    const r = await db.execute(`SELECT status, error FROM publication_queue WHERE id = 1`);
    expect(r.rows[0].status).toBe("failed");
    expect(r.rows[0].error).toBe("network timeout");
  });
});

describe("publication_queue — getOccupiedQueueSlots", () => {
  let db: Client;
  beforeEach(async () => {
    db = await setupTestDb();
  });
  afterEach(() => db.close());

  const occupied = (platform: string) =>
    db.execute({
      sql: `SELECT scheduled_at FROM publication_queue WHERE platform = ? AND status IN ('pending', 'publishing', 'published')`,
      args: [platform],
    });

  it("returns active (pending/publishing/published) slots, excluding freed (failed/cancelled) ones", async () => {
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00", status: "pending" });
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-07 15:00:00", status: "publishing" });
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-09 15:00:00", status: "published" });
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-12 15:00:00", status: "failed" });
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-14 15:00:00", status: "cancelled" });
    const r = await occupied("facebook");
    expect(r.rows.map((row) => String(row.scheduled_at)).sort()).toEqual([
      "2026-01-05 15:00:00",
      "2026-01-07 15:00:00",
      "2026-01-09 15:00:00",
    ]);
  });

  it("scopes occupancy to the requested platform", async () => {
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00" });
    await insert(db, { platform: "instagram", scheduled_at: "2026-01-05 15:00:00" });
    const r = await occupied("instagram");
    expect(r.rows).toHaveLength(1);
    expect(String(r.rows[0].scheduled_at)).toBe("2026-01-05 15:00:00");
  });
});

describe("publication_queue — partial unique slot index (double-book backstop)", () => {
  let db: Client;
  beforeEach(async () => {
    db = await setupTestDb();
  });
  afterEach(() => db.close());

  it("rejects a second active item in the same platform+slot", async () => {
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00", status: "pending" });
    await expect(
      insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00", status: "pending" }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it("allows the same slot on a different platform", async () => {
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00" });
    await expect(
      insert(db, { platform: "instagram", scheduled_at: "2026-01-05 15:00:00" }),
    ).resolves.toBeUndefined();
  });

  it("frees the slot once the prior item is failed/cancelled (partial index drops inactive rows)", async () => {
    await insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00", status: "failed" });
    // failed row is outside the partial index, so a fresh pending item can take the slot.
    await expect(
      insert(db, { platform: "facebook", scheduled_at: "2026-01-05 15:00:00", status: "pending" }),
    ).resolves.toBeUndefined();
  });
});

describe("publication_queue — claimQueueItem (atomic pending → publishing)", () => {
  let db: Client;
  beforeEach(async () => {
    db = await setupTestDb();
  });
  afterEach(() => db.close());

  // Mirrors claimQueueItem(): only the first claimer flips pending → publishing.
  const claim = (id: number) =>
    db.execute({
      sql: `UPDATE publication_queue SET status = 'publishing' WHERE id = ? AND status = 'pending'`,
      args: [id],
    });

  it("first claim wins (rowsAffected 1), second claim loses (rowsAffected 0)", async () => {
    await insert(db, { content_id: "x", scheduled_at: "2020-01-01 00:00:00", status: "pending" });
    const first = await claim(1);
    expect(Number(first.rowsAffected)).toBe(1);
    const second = await claim(1);
    expect(Number(second.rowsAffected)).toBe(0);
    const r = await db.execute(`SELECT status FROM publication_queue WHERE id = 1`);
    expect(r.rows[0].status).toBe("publishing");
  });
});

describe("publication_queue — status CHECK constraint", () => {
  let db: Client;
  beforeEach(async () => {
    db = await setupTestDb();
  });
  afterEach(() => db.close());

  it("rejects a typo'd status that would otherwise vanish from status-filtered queries", async () => {
    await expect(
      insert(db, { scheduled_at: "2020-01-01 00:00:00", status: "publish" }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });
});
