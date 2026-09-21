import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

/**
 * The SQL behind approveContentBatchDraft / cancelContentBatchDraft /
 * rescheduleContentBatchDraft / getContentBatchQueueItems / countContentBatchQueueItems
 * (database.ts), run against a real in-memory SQLite table — mirrors
 * sequential-ads-queue-sql.test.ts's approach for the same reason: these are
 * `content_type`-parametrized versions of the sequential_ad functions, and the thing
 * actually worth verifying is that the `content_type = ?` guard genuinely scopes each
 * content type's rows independently (a demand_gen_ext approve must never touch a
 * before_after row with the same id, etc).
 */

const CREATE = `CREATE TABLE publication_queue (
  id INTEGER PRIMARY KEY, content_type TEXT, content_id TEXT, platform TEXT,
  payload TEXT, scheduled_at TEXT, status TEXT, metadata TEXT, created_at TEXT,
  error TEXT, published_at TEXT
)`;
// Matches production exactly (database.ts): (platform, scheduled_at) only — NOT scoped by
// content_type. Slot uniqueness is platform-wide across every content type, same as it has
// been for every prior addition (video, sequential_ad, …). getOccupiedQueueSlots(platform,
// contentType) only scopes the QUERY that searches for a free slot to OFFER; it does not
// partition this constraint, so two different content types genuinely can collide here.
const ACTIVE_SLOT_INDEX = `CREATE UNIQUE INDEX idx_active_slot ON publication_queue(platform, scheduled_at) WHERE status IN ('pending', 'publishing', 'published')`;

async function insert(
  db: Client,
  row: { id: number; content_type: string; scheduled_at: string; status: string; platform?: string },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO publication_queue (id, content_type, content_id, platform, payload, scheduled_at, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id, row.content_type, `sku-${row.id}`, row.platform ?? "facebook", "{}",
      row.scheduled_at, row.status, "2026-09-20 00:00:00",
    ],
  });
}

// Verbatim from database.ts's approveContentBatchDraft.
async function approve(db: Client, id: number, contentType: string, scheduledAt: string): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE publication_queue SET status = 'pending', scheduled_at = ?
          WHERE id = ? AND status = 'draft' AND content_type = ?`,
    args: [scheduledAt, id, contentType],
  });
  return (result.rowsAffected ?? 0) === 1;
}

// Verbatim from database.ts's cancelContentBatchDraft.
async function cancel(db: Client, id: number, contentType: string): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE publication_queue SET status = 'cancelled'
          WHERE id = ? AND status = 'draft' AND content_type = ?`,
    args: [id, contentType],
  });
  return (result.rowsAffected ?? 0) === 1;
}

// Verbatim from database.ts's rescheduleContentBatchDraft.
async function reschedule(db: Client, id: number, contentType: string, scheduledAt: string): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE publication_queue SET status = 'pending', scheduled_at = ?
          WHERE id = ? AND content_type = ? AND status IN ('draft', 'pending')`,
    args: [scheduledAt, id, contentType],
  });
  return (result.rowsAffected ?? 0) === 1;
}

async function getByType(db: Client, contentType: string) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM publication_queue WHERE content_type = ? AND status != 'cancelled' ORDER BY created_at DESC, id DESC`,
    args: [contentType],
  });
  return rows;
}

describe("content-batch queue SQL — content_type isolation", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(CREATE);
    await db.execute(ACTIVE_SLOT_INDEX);
  });
  afterEach(() => db.close());

  it("approves a draft of the matching content_type, reserving its slot", async () => {
    await insert(db, { id: 1, content_type: "demand_gen_ext", scheduled_at: "2026-10-01 13:00:00", status: "draft" });
    const ok = await approve(db, 1, "demand_gen_ext", "2026-10-02 13:00:00");
    expect(ok).toBe(true);
    const rows = await getByType(db, "demand_gen_ext");
    expect(rows).toHaveLength(1);
    expect((rows[0] as unknown as Record<string, unknown>).status).toBe("pending");
    expect((rows[0] as unknown as Record<string, unknown>).scheduled_at).toBe("2026-10-02 13:00:00");
  });

  it("a wrong content_type never approves another format's row with the same id", async () => {
    await insert(db, { id: 1, content_type: "before_after", scheduled_at: "2026-10-01 13:00:00", status: "draft" });
    const ok = await approve(db, 1, "assembly", "2026-10-02 13:00:00");
    expect(ok).toBe(false);
    const rows = await getByType(db, "before_after");
    expect((rows[0] as unknown as Record<string, unknown>).status).toBe("draft"); // untouched
  });

  it("does not re-approve an already-approved (pending) row", async () => {
    await insert(db, { id: 1, content_type: "assembly", scheduled_at: "2026-10-01 13:00:00", status: "pending" });
    const ok = await approve(db, 1, "assembly", "2026-10-05 13:00:00");
    expect(ok).toBe(false);
  });

  it("rejects a slot already taken by another row of the SAME content_type + platform", async () => {
    await insert(db, { id: 1, content_type: "demand_gen_ext", scheduled_at: "2026-10-01 13:00:00", status: "pending" });
    await insert(db, { id: 2, content_type: "demand_gen_ext", scheduled_at: "2026-10-05 13:00:00", status: "draft" });
    await expect(approve(db, 2, "demand_gen_ext", "2026-10-01 13:00:00")).rejects.toThrow();
  });

  it("the DB-level slot constraint is platform-wide: a DIFFERENT content_type on the same slot still collides", async () => {
    // This documents real behavior, not the aspirational "independent slot pools" reading of
    // the code comments: idx_publication_queue_active_slot is (platform, scheduled_at) only,
    // with no content_type column, and has been since it was first created — verified against
    // every migration in database.ts. getOccupiedQueueSlots(platform, contentType) scopes the
    // SEARCH for a free slot per type, but the actual uniqueness constraint doesn't know
    // content_type exists, so two types can still collide here and rely on QueueSlotTakenError
    // + retry (exactly what the sequential-ads approve route's retry loop is for).
    await insert(db, { id: 1, content_type: "demand_gen_ext", scheduled_at: "2026-10-01 13:00:00", status: "pending" });
    await insert(db, { id: 2, content_type: "before_after", scheduled_at: "2026-10-05 13:00:00", status: "draft" });
    await expect(approve(db, 2, "before_after", "2026-10-01 13:00:00")).rejects.toThrow();
  });

  it("cancel only acts on a draft row, never an already-pending or published one", async () => {
    await insert(db, { id: 1, content_type: "assembly", scheduled_at: "2026-10-01 13:00:00", status: "draft" });
    await insert(db, { id: 2, content_type: "assembly", scheduled_at: "2026-10-02 13:00:00", status: "pending" });
    expect(await cancel(db, 1, "assembly")).toBe(true);
    expect(await cancel(db, 2, "assembly")).toBe(false);
    const rows = await getByType(db, "assembly");
    expect(rows).toHaveLength(1); // the cancelled one is filtered out by status != 'cancelled'
  });

  it("reschedule accepts a draft OR an already-pending row (move an already-scheduled item)", async () => {
    await insert(db, { id: 1, content_type: "before_after", scheduled_at: "2026-10-01 13:00:00", status: "draft" });
    await insert(db, { id: 2, content_type: "before_after", scheduled_at: "2026-10-02 13:00:00", status: "pending" });
    expect(await reschedule(db, 1, "before_after", "2026-11-01 13:00:00")).toBe(true);
    expect(await reschedule(db, 2, "before_after", "2026-11-02 13:00:00")).toBe(true);
  });

  it("reschedule refuses a published/failed/cancelled row", async () => {
    await insert(db, { id: 1, content_type: "assembly", scheduled_at: "2026-10-01 13:00:00", status: "published" });
    expect(await reschedule(db, 1, "assembly", "2026-11-01 13:00:00")).toBe(false);
  });

  it("countContentBatchQueueItems excludes cancelled rows, per content_type", async () => {
    await insert(db, { id: 1, content_type: "demand_gen_ext", scheduled_at: "2026-10-01 13:00:00", status: "draft" });
    await insert(db, { id: 2, content_type: "demand_gen_ext", scheduled_at: "2026-10-02 13:00:00", status: "cancelled" });
    await insert(db, { id: 3, content_type: "before_after", scheduled_at: "2026-10-03 13:00:00", status: "draft" });
    const { rows } = await db.execute({
      sql: `SELECT COUNT(*) n FROM publication_queue WHERE content_type = ? AND status != 'cancelled'`,
      args: ["demand_gen_ext"],
    });
    expect(Number((rows[0] as unknown as Record<string, unknown>).n)).toBe(1);
  });
});
