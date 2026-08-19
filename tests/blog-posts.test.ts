import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// Exercises the blog_posts DDL + the statements recordBlogPost/listBlogPosts issue, directly
// against an in-memory libsql DB. Same approach as blog-publish-cap.test.ts: the exported
// helpers bind a process-singleton client, so the DDL and statements are replicated here and
// keeping them in lockstep with database.ts is the contract.

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr', 'en')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'published', 'failed')),
  shopify_article_id TEXT,
  approved_at INTEGER,
  published_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`;

async function insert(
  db: Client,
  title: string,
  lang: string,
  status: string,
  articleId: string | null,
  createdAt: number,
) {
  const r = await db.execute({
    sql: `INSERT INTO blog_posts (title, lang, status, shopify_article_id, created_at)
          VALUES (?, ?, ?, ?, ?) RETURNING id`,
    args: [title, lang, status, articleId, createdAt],
  });
  return Number(r.rows[0].id);
}

async function list(db: Client, limit = 50) {
  const r = await db.execute({
    sql: `SELECT id, title, lang, status, shopify_article_id, approved_at, published_at, created_at
          FROM blog_posts ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [limit],
  });
  return r.rows;
}

/** Mirrors approveBlogPost: the status guard lives in the WHERE clause. */
async function approve(db: Client, id: number, at = 1_700_000_100) {
  const r = await db.execute({
    sql: `UPDATE blog_posts SET status = 'approved', approved_at = ?
          WHERE id = ? AND status = 'draft'`,
    args: [at, id],
  });
  return r.rowsAffected > 0;
}

/** Mirrors markBlogPostPublished. */
async function publish(db: Client, id: number, at = 1_700_000_200) {
  const r = await db.execute({
    sql: `UPDATE blog_posts SET status = 'published', published_at = ?
          WHERE id = ? AND status = 'approved'`,
    args: [at, id],
  });
  return r.rowsAffected > 0;
}

/** Mirrors countBlogPostsByStatus. */
async function counts(db: Client) {
  const r = await db.execute(`SELECT status, COUNT(*) AS c FROM blog_posts GROUP BY status`);
  return Object.fromEntries(r.rows.map((row) => [String(row.status), Number(row.c)]));
}

describe("blog_posts — generation log", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(TABLE_DDL);
  });
  afterEach(() => db.close());

  it("stores a draft row with its Shopify article id", async () => {
    const id = await insert(db, "Aménager un petit salon", "fr", "draft", "999", 1_700_000_000);
    expect(id).toBeGreaterThan(0);

    const rows = await list(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Aménager un petit salon");
    expect(rows[0].lang).toBe("fr");
    expect(rows[0].status).toBe("draft");
    expect(String(rows[0].shopify_article_id)).toBe("999");
  });

  it("allows a failed row with no Shopify article id", async () => {
    await insert(db, "Sujet raté", "fr", "failed", null, 1_700_000_000);
    const rows = await list(db);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].shopify_article_id).toBeNull();
  });

  it("returns newest first, breaking ties on id", async () => {
    await insert(db, "plus ancien", "fr", "draft", "1", 1_000);
    await insert(db, "plus récent", "en", "published", "2", 2_000);
    const sameSecondA = await insert(db, "même seconde A", "fr", "draft", "3", 3_000);
    const sameSecondB = await insert(db, "même seconde B", "fr", "draft", "4", 3_000);

    const rows = await list(db);
    expect(rows.map((r) => r.title)).toEqual([
      "même seconde B",
      "même seconde A",
      "plus récent",
      "plus ancien",
    ]);
    expect(sameSecondB).toBeGreaterThan(sameSecondA);
  });

  it("honours the LIMIT", async () => {
    for (let i = 0; i < 5; i++) {
      await insert(db, `article ${i}`, "fr", "draft", String(i), 1_000 + i);
    }
    expect(await list(db, 2)).toHaveLength(2);
  });

  it("rejects a status outside the enum", async () => {
    await expect(
      insert(db, "mauvais statut", "fr", "publishedd", "1", 1_000),
    ).rejects.toThrow();
  });

  it("rejects a language outside the enum", async () => {
    await expect(insert(db, "mauvaise langue", "es", "draft", "1", 1_000)).rejects.toThrow();
  });

  it("defaults lang to fr when omitted", async () => {
    await db.execute({
      sql: `INSERT INTO blog_posts (title, status, created_at) VALUES (?, ?, ?)`,
      args: ["sans langue", "draft", 1_000],
    });
    const rows = await list(db);
    expect(rows[0].lang).toBe("fr");
  });
});

describe("blog_posts — draft → approved → published lifecycle", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(TABLE_DDL);
  });
  afterEach(() => db.close());

  it("walks a draft through approval and publication, stamping both timestamps", async () => {
    const id = await insert(db, "Guide gazebo", "fr", "draft", "123", 1_700_000_000);

    expect(await approve(db, id)).toBe(true);
    let row = (await list(db))[0];
    expect(row.status).toBe("approved");
    expect(Number(row.approved_at)).toBe(1_700_000_100);
    expect(row.published_at).toBeNull();

    expect(await publish(db, id)).toBe(true);
    row = (await list(db))[0];
    expect(row.status).toBe("published");
    expect(Number(row.published_at)).toBe(1_700_000_200);
  });

  it("refuses to approve anything that is not a draft (second approval loses)", async () => {
    const id = await insert(db, "Déjà approuvé", "fr", "draft", "123", 1_700_000_000);
    expect(await approve(db, id)).toBe(true);
    expect(await approve(db, id)).toBe(false);
  });

  it("refuses to publish a row that was never approved", async () => {
    const id = await insert(db, "Encore brouillon", "en", "draft", "456", 1_700_000_000);
    expect(await publish(db, id)).toBe(false);
    expect((await list(db))[0].status).toBe("draft");
  });

  it("accepts 'approved' as a valid status value", async () => {
    const id = await insert(db, "Approuvé direct", "en", "approved", "789", 1_700_000_000);
    expect(id).toBeGreaterThan(0);
  });

  it("counts rows per status", async () => {
    await insert(db, "a", "fr", "draft", "1", 1_000);
    await insert(db, "b", "fr", "draft", "2", 1_001);
    await insert(db, "c", "en", "approved", "3", 1_002);
    await insert(db, "d", "en", "published", "4", 1_003);
    await insert(db, "e", "fr", "failed", null, 1_004);

    expect(await counts(db)).toEqual({ draft: 2, approved: 1, published: 1, failed: 1 });
  });

  it("filters by lang and status the way listBlogPosts does", async () => {
    await insert(db, "fr-draft", "fr", "draft", "1", 1_000);
    await insert(db, "en-draft", "en", "draft", "2", 1_001);
    await insert(db, "fr-published", "fr", "published", "3", 1_002);

    const r = await db.execute({
      sql: `SELECT title FROM blog_posts WHERE lang = ? AND status = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: ["fr", "draft", 50],
    });
    expect(r.rows.map((row) => row.title)).toEqual(["fr-draft"]);
  });
});
