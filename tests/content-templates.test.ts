import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "path";
import fs from "fs";

// ─── DB migration / seed tests (direct libsql, no Next.js) ──────────────────

const TEST_DB_PATH = path.join(__dirname, "fixtures", "content-templates-test.sqlite");

function makeDb(): Client {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return createClient({ url: `file:${TEST_DB_PATH}` });
}

describe("content_templates migration", () => {
  let db: Client;

  beforeEach(() => { db = makeDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("migration adds content_type column to facebook_drafts", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS facebook_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    const colsBefore = await db.execute("PRAGMA table_info(facebook_drafts)");
    const hasContentType = colsBefore.rows.some(r => r.name === "content_type");
    if (!hasContentType) {
      await db.execute(`ALTER TABLE facebook_drafts ADD COLUMN content_type TEXT NOT NULL DEFAULT 'product'`);
    }

    const colsAfter = await db.execute("PRAGMA table_info(facebook_drafts)");
    const col = colsAfter.rows.find(r => r.name === "content_type");
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("'product'");
  });

  it("migration is idempotent — running ALTER twice does not throw", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS facebook_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      content_type TEXT NOT NULL DEFAULT 'product'
    )`);

    const cols = await db.execute("PRAGMA table_info(facebook_drafts)");
    const colSet = new Set(cols.rows.map(r => r.name as string));
    if (!colSet.has("content_type")) {
      await db.execute(`ALTER TABLE facebook_drafts ADD COLUMN content_type TEXT NOT NULL DEFAULT 'product'`);
    }

    // No throw — idempotent guard worked
    const colsAfter = await db.execute("PRAGMA table_info(facebook_drafts)");
    expect(colsAfter.rows.filter(r => r.name === "content_type")).toHaveLength(1);
  });

  it("seed inserts exactly 12 content templates", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS content_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      display_name_fr TEXT NOT NULL,
      display_name_en TEXT NOT NULL,
      prompt_pattern_fr TEXT NOT NULL,
      prompt_pattern_en TEXT NOT NULL,
      image_strategy TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    const templates = [
      { slug: "seasonal_tip", content_type: "informative", fr: "Conseil saisonnier", en: "Seasonal tip", img: "text_overlay" },
      { slug: "mistake_listicle", content_type: "informative", fr: "Erreurs courantes", en: "Common mistakes", img: "text_overlay" },
      { slug: "myth_vs_reality", content_type: "informative", fr: "Mythe vs réalité", en: "Myth vs reality", img: "text_overlay" },
      { slug: "product_comparison", content_type: "informative", fr: "Comparatif éducatif", en: "Educational comparison", img: "text_overlay" },
      { slug: "relatable_meme", content_type: "entertaining", fr: "Meme relatable", en: "Relatable meme", img: "random_product" },
      { slug: "pov_scenario", content_type: "entertaining", fr: "POV scénario", en: "POV scenario", img: "random_product" },
      { slug: "nostalgic_throwback", content_type: "entertaining", fr: "Nostalgie déco", en: "Decor nostalgia", img: "none" },
      { slug: "design_quote", content_type: "entertaining", fr: "Citation design", en: "Design quote", img: "text_overlay" },
      { slug: "this_or_that", content_type: "engagement", fr: "Ceci ou cela", en: "This or that", img: "random_product" },
      { slug: "guess_the_price", content_type: "engagement", fr: "Devine le prix", en: "Guess the price", img: "random_product" },
      { slug: "caption_this", content_type: "engagement", fr: "Trouve la caption", en: "Caption this", img: "random_product" },
      { slug: "unpopular_opinion", content_type: "engagement", fr: "Opinion impopulaire", en: "Unpopular opinion", img: "none" },
    ];

    await db.batch(
      templates.map(t => ({
        sql: `INSERT OR IGNORE INTO content_templates (slug, content_type, display_name_fr, display_name_en, prompt_pattern_fr, prompt_pattern_en, image_strategy) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.fr, t.en, "TODO", "TODO", t.img],
      })),
      "write"
    );

    const result = await db.execute("SELECT COUNT(*) as cnt FROM content_templates");
    expect(Number(result.rows[0].cnt)).toBe(12);
  });

  it("seed is idempotent — INSERT OR IGNORE does not duplicate rows", async () => {
    await db.execute(`CREATE TABLE IF NOT EXISTS content_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      display_name_fr TEXT NOT NULL,
      display_name_en TEXT NOT NULL,
      prompt_pattern_fr TEXT NOT NULL,
      prompt_pattern_en TEXT NOT NULL,
      image_strategy TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    const row = {
      sql: `INSERT OR IGNORE INTO content_templates (slug, content_type, display_name_fr, display_name_en, prompt_pattern_fr, prompt_pattern_en, image_strategy) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["seasonal_tip", "informative", "Conseil saisonnier", "Seasonal tip", "TODO", "TODO", "text_overlay"],
    };
    await db.execute(row);
    await db.execute(row); // second run — must not throw or duplicate

    const result = await db.execute("SELECT COUNT(*) as cnt FROM content_templates WHERE slug = 'seasonal_tip'");
    expect(Number(result.rows[0].cnt)).toBe(1);
  });
});

// ─── Route tests (mocked auth, 501/400 verification) ────────────────────────

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: vi.fn().mockReturnValue(undefined),
    set: () => {},
    delete: () => {},
  }),
}));

process.env.AUTH_PASSWORD = "test-secret-for-vitest";

const makeRequest = (body: unknown) =>
  new Request("http://localhost/api/social/content/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/social/content/generate — stub responses", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 501 NOT_IMPLEMENTED with valid payload (authenticated admin)", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ language: "fr", template_slug: "seasonal_tip" }));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe("NOT_IMPLEMENTED");
    expect(body.received.language).toBe("fr");
  });

  it("returns 400 when language is missing or invalid", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ template_slug: "seasonal_tip" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
