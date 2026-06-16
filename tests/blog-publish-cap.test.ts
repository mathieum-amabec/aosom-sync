import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Exercises the blog_publish_counter SQL (atomic reserve / release) directly against an
// in-memory libsql DB. The exported helpers bind a process-singleton client, so — like
// database.test.ts / publication-queue.test.ts — we replicate the DDL and run the same
// statements. Keeping the DDL + statements in lockstep with database.ts is the contract.

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS blog_publish_counter (
  week TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0
)`;

// Mirrors reserveBlogPublishSlot(week, cap): atomic "increment iff under cap".
async function reserve(db: Client, week: string, cap: number): Promise<boolean> {
  if (cap < 1) return false;
  const r = await db.execute({
    sql: `INSERT INTO blog_publish_counter (week, count) VALUES (?, 1)
          ON CONFLICT(week) DO UPDATE SET count = count + 1 WHERE count < ?
          RETURNING count`,
    args: [week, cap],
  });
  return r.rows.length > 0;
}

async function release(db: Client, week: string): Promise<void> {
  await db.execute({ sql: `UPDATE blog_publish_counter SET count = MAX(0, count - 1) WHERE week = ?`, args: [week] });
}

async function countOf(db: Client, week: string): Promise<number> {
  const r = await db.execute({ sql: `SELECT count FROM blog_publish_counter WHERE week = ?`, args: [week] });
  return r.rows.length ? Number(r.rows[0].count) : 0;
}

describe("blog_publish_counter — weekly cap reserve/release", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(TABLE_DDL);
  });
  afterEach(() => db.close());

  it("allows exactly `cap` reservations per week, then refuses", async () => {
    expect(await reserve(db, "2026-W29", 2)).toBe(true); // 1
    expect(await reserve(db, "2026-W29", 2)).toBe(true); // 2
    expect(await reserve(db, "2026-W29", 2)).toBe(false); // at cap
    expect(await countOf(db, "2026-W29")).toBe(2);
  });

  it("scopes the cap per week (a new week resets)", async () => {
    expect(await reserve(db, "2026-W29", 2)).toBe(true);
    expect(await reserve(db, "2026-W29", 2)).toBe(true);
    expect(await reserve(db, "2026-W29", 2)).toBe(false);
    // Different week starts fresh.
    expect(await reserve(db, "2026-W30", 2)).toBe(true);
    expect(await countOf(db, "2026-W30")).toBe(1);
  });

  it("cap of 0 never reserves and never inserts a row", async () => {
    expect(await reserve(db, "2026-W29", 0)).toBe(false);
    expect(await countOf(db, "2026-W29")).toBe(0);
  });

  it("release frees a slot so a new reservation fits under the cap", async () => {
    await reserve(db, "2026-W29", 2);
    await reserve(db, "2026-W29", 2); // at cap (2)
    await release(db, "2026-W29"); // back to 1
    expect(await reserve(db, "2026-W29", 2)).toBe(true);
    expect(await countOf(db, "2026-W29")).toBe(2);
  });

  it("release floors at 0 (never goes negative)", async () => {
    await reserve(db, "2026-W29", 2); // 1
    await release(db, "2026-W29"); // 0
    await release(db, "2026-W29"); // stays 0
    expect(await countOf(db, "2026-W29")).toBe(0);
  });
});
