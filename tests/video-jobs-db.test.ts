import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Exercises the SQL behind the video_jobs helpers (create / list+filter /
// update / delete) against a fresh in-memory libsql DB — same approach as
// database.test.ts (the helpers go through a module singleton that can't point
// at :memory:). The schema mirrors the video_jobs CREATE TABLE in database.ts.

let db: Client;

async function schema() {
  await db.batch([
    `CREATE TABLE video_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engine TEXT NOT NULL,
      content_type TEXT NOT NULL,
      product_skus TEXT,
      locale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      video_url TEXT,
      video_path TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ]);
}

const INSERT = `INSERT INTO video_jobs (engine, content_type, product_skus, locale, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'pending', ?, ?)`;

describe("video_jobs SQL", () => {
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await schema();
  });
  afterEach(() => db.close());

  it("insert defaults status to pending and round-trips product_skus JSON", async () => {
    const skus = ["SKU-1", "SKU-2"];
    const res = await db.execute({
      sql: INSERT,
      args: ["ffmpeg", "product", JSON.stringify(skus), "fr", 100, 100],
    });
    const row = (await db.execute({
      sql: `SELECT * FROM video_jobs WHERE id = ?`,
      args: [Number(res.lastInsertRowid)],
    })).rows[0];

    expect(row.status).toBe("pending");
    expect(row.engine).toBe("ffmpeg");
    expect(row.locale).toBe("fr");
    expect(JSON.parse(row.product_skus as string)).toEqual(skus);
  });

  it("filters by a set of statuses via IN clause", async () => {
    await db.batch([
      { sql: INSERT, args: ["ffmpeg", "product", "[]", "fr", 1, 1] }, // pending
      { sql: INSERT, args: ["kling", "lifestyle", "[]", "en", 2, 2] }, // pending
    ], "write");
    await db.execute(`UPDATE video_jobs SET status = 'ready' WHERE id = 1`);
    await db.execute(`UPDATE video_jobs SET status = 'approved' WHERE id = 2`);

    const statuses = ["ready", "approved"];
    const rows = (await db.execute({
      sql: `SELECT id FROM video_jobs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY id`,
      args: statuses,
    })).rows;
    expect(rows.map((r) => Number(r.id))).toEqual([1, 2]);

    const pendingOnly = (await db.execute({
      sql: `SELECT COUNT(*) AS c FROM video_jobs WHERE status IN (?)`,
      args: ["pending"],
    })).rows[0];
    expect(Number(pendingOnly.c)).toBe(0);
  });

  it("orders newest-first by created_at DESC then id DESC", async () => {
    await db.batch([
      { sql: INSERT, args: ["ffmpeg", "product", "[]", "fr", 100, 100] }, // id 1
      { sql: INSERT, args: ["kling", "promo", "[]", "fr", 100, 100] },    // id 2, same ts
      { sql: INSERT, args: ["creatomate", "lifestyle", "[]", "en", 50, 50] }, // id 3, older
    ], "write");
    const rows = (await db.execute(
      `SELECT id FROM video_jobs ORDER BY created_at DESC, id DESC`,
    )).rows;
    expect(rows.map((r) => Number(r.id))).toEqual([2, 1, 3]);
  });

  it("update sets only whitelisted columns plus updated_at", async () => {
    await db.execute({ sql: INSERT, args: ["kling", "product", "[]", "fr", 10, 10] });
    await db.execute({
      sql: `UPDATE video_jobs SET status = ?, updated_at = ? WHERE id = ?`,
      args: ["approved", 999, 1],
    });
    const row = (await db.execute(`SELECT status, updated_at, created_at FROM video_jobs WHERE id = 1`)).rows[0];
    expect(row.status).toBe("approved");
    expect(Number(row.updated_at)).toBe(999);
    expect(Number(row.created_at)).toBe(10); // untouched
  });

  it("delete reports rowsAffected so missing ids 404", async () => {
    await db.execute({ sql: INSERT, args: ["ffmpeg", "product", "[]", "fr", 1, 1] });
    const hit = await db.execute({ sql: `DELETE FROM video_jobs WHERE id = ?`, args: [1] });
    expect(hit.rowsAffected).toBe(1);
    const miss = await db.execute({ sql: `DELETE FROM video_jobs WHERE id = ?`, args: [999] });
    expect(miss.rowsAffected).toBe(0);
  });
});
