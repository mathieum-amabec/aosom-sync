import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "path";
import fs from "fs";
import { MEGASTORE_TEMPLATES } from "@/lib/seed/content-templates-megastore";

// ─── DB migration / seed tests (direct libsql, no Next.js) ──────────────────

const TEST_DB_PATH = path.join(__dirname, "fixtures", "content-templates-test.sqlite");

function makeDb(): Client {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return createClient({ url: `file:${TEST_DB_PATH}` });
}

async function createTemplatesTable(db: Client, withNewCols = true) {
  const extra = withNewCols
    ? `, frequency_per_month INTEGER NOT NULL DEFAULT 2, scopes TEXT NOT NULL DEFAULT '[]'`
    : "";
  await db.execute(`CREATE TABLE IF NOT EXISTS content_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    display_name_fr TEXT NOT NULL,
    display_name_en TEXT NOT NULL,
    prompt_pattern_fr TEXT NOT NULL,
    prompt_pattern_en TEXT NOT NULL,
    image_strategy TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
    ${extra}
  )`);
}

describe("content_templates — megastore migration", () => {
  let db: Client;

  beforeEach(() => { db = makeDb(); });
  afterEach(async () => { db.close(); if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); });

  it("ALTER TABLE adds frequency_per_month to legacy schema", async () => {
    await createTemplatesTable(db, false);
    const colsBefore = await db.execute("PRAGMA table_info(content_templates)");
    const hasFreq = colsBefore.rows.some((r) => r.name === "frequency_per_month");
    if (!hasFreq) {
      await db.execute(`ALTER TABLE content_templates ADD COLUMN frequency_per_month INTEGER NOT NULL DEFAULT 2`);
    }
    const colsAfter = await db.execute("PRAGMA table_info(content_templates)");
    const col = colsAfter.rows.find((r) => r.name === "frequency_per_month");
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("2");
  });

  it("ALTER TABLE adds scopes to legacy schema", async () => {
    await createTemplatesTable(db, false);
    const cols = await db.execute("PRAGMA table_info(content_templates)");
    const hasScopes = cols.rows.some((r) => r.name === "scopes");
    if (!hasScopes) {
      await db.execute(`ALTER TABLE content_templates ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'`);
    }
    const colsAfter = await db.execute("PRAGMA table_info(content_templates)");
    const col = colsAfter.rows.find((r) => r.name === "scopes");
    expect(col).toBeDefined();
    expect(col?.dflt_value).toBe("'[]'");
  });

  it("ALTER TABLE is idempotent — running twice does not throw", async () => {
    await createTemplatesTable(db, true);
    // Columns already exist — PRAGMA guard must prevent ALTER
    const cols = await db.execute("PRAGMA table_info(content_templates)");
    const colSet = new Set(cols.rows.map((r) => r.name as string));
    if (!colSet.has("frequency_per_month")) {
      await db.execute(`ALTER TABLE content_templates ADD COLUMN frequency_per_month INTEGER NOT NULL DEFAULT 2`);
    }
    if (!colSet.has("scopes")) {
      await db.execute(`ALTER TABLE content_templates ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'`);
    }
    const colsAfter = await db.execute("PRAGMA table_info(content_templates)");
    expect(colsAfter.rows.filter((r) => r.name === "frequency_per_month")).toHaveLength(1);
    expect(colsAfter.rows.filter((r) => r.name === "scopes")).toHaveLength(1);
  });

  it("seeds exactly 12 megastore templates", async () => {
    await createTemplatesTable(db, true);
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en,
               t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
               t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    const result = await db.execute("SELECT COUNT(*) as cnt FROM content_templates");
    expect(Number(result.rows[0].cnt)).toBe(12);
  });

  it("all 12 templates have new megastore slugs (no old TODO slugs)", async () => {
    await createTemplatesTable(db, true);
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en,
               t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
               t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    // Old slugs must be gone
    const oldSlugs = ["seasonal_tip", "mistake_listicle", "relatable_meme", "this_or_that"];
    for (const slug of oldSlugs) {
      const r = await db.execute({ sql: `SELECT id FROM content_templates WHERE slug = ?`, args: [slug] });
      expect(r.rows).toHaveLength(0);
    }
    // New slugs must exist
    const newSlugs = ["conseil_deco_piece", "guide_achat_categorie", "astuces_entretien",
                      "inspiration_ambiance_maison", "inspiration_vie_outdoor", "inspiration_animaux",
                      "inspiration_famille", "sondage_debat", "devine_quizz",
                      "aide_choisir", "saisonnier_outdoor", "saisonnier_indoor"];
    for (const slug of newSlugs) {
      const r = await db.execute({ sql: `SELECT id FROM content_templates WHERE slug = ?`, args: [slug] });
      expect(r.rows).toHaveLength(1);
    }
  });

  it("content_type values match megastore categories", async () => {
    await createTemplatesTable(db, true);
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en,
               t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
               t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    const counts = await db.execute(`
      SELECT content_type, COUNT(*) as cnt FROM content_templates GROUP BY content_type ORDER BY content_type
    `);
    const byType: Record<string, number> = {};
    counts.rows.forEach((r) => { byType[r.content_type as string] = Number(r.cnt); });
    expect(byType["education"]).toBe(3);
    expect(byType["inspiration"]).toBe(4);
    expect(byType["engagement"]).toBe(3);
    expect(byType["seasonal"]).toBe(2);
    // Old types must not exist
    expect(byType["informative"]).toBeUndefined();
    expect(byType["entertaining"]).toBeUndefined();
  });

  it("scopes are valid JSON arrays for all templates", async () => {
    await createTemplatesTable(db, true);
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en,
               t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
               t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    const rows = await db.execute("SELECT slug, scopes FROM content_templates");
    for (const row of rows.rows) {
      const parsed = JSON.parse(row.scopes as string) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
      expect((parsed as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("frequency_per_month is between 1 and 3 for all templates", async () => {
    await createTemplatesTable(db, true);
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en,
               t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
               t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    const rows = await db.execute("SELECT slug, frequency_per_month FROM content_templates");
    for (const row of rows.rows) {
      const freq = Number(row.frequency_per_month);
      expect(freq).toBeGreaterThanOrEqual(1);
      expect(freq).toBeLessThanOrEqual(3);
    }
  });

  it("prompt_pattern_fr is non-empty and contains {{hook}} for all templates", async () => {
    await createTemplatesTable(db, true);
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en,
               t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
               t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    const rows = await db.execute("SELECT slug, prompt_pattern_fr FROM content_templates");
    for (const row of rows.rows) {
      const prompt = row.prompt_pattern_fr as string;
      expect(prompt.length).toBeGreaterThan(200);
      expect(prompt).toContain("{{hook}}");
      expect(prompt).not.toContain("TODO:");
    }
  });

  it("migration is one-shot idempotent — conseil_deco_piece check prevents re-delete", async () => {
    await createTemplatesTable(db, true);
    // First run: insert all 12
    await db.batch(
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates (slug, content_type, display_name_fr, display_name_en, prompt_pattern_fr, prompt_pattern_en, image_strategy, active, frequency_per_month, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en, t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy, t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })),
      "write"
    );
    // Manually edit one prompt (simulates user customization)
    await db.execute({ sql: `UPDATE content_templates SET prompt_pattern_fr = 'custom_edited' WHERE slug = 'conseil_deco_piece'`, args: [] });

    // Second run: migration guard should fire — conseil_deco_piece exists, so NO re-delete
    const check = await db.execute(`SELECT slug FROM content_templates WHERE slug = 'conseil_deco_piece' LIMIT 1`);
    if (check.rows.length === 0) {
      await db.execute("DELETE FROM content_templates");
      await db.batch(MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates (slug, content_type, display_name_fr, display_name_en, prompt_pattern_fr, prompt_pattern_en, image_strategy, active, frequency_per_month, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [t.slug, t.content_type, t.display_name_fr, t.display_name_en, t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy, t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes)],
      })), "write");
    }

    // Custom edit must survive — migration did NOT run again
    const r = await db.execute({ sql: `SELECT prompt_pattern_fr FROM content_templates WHERE slug = 'conseil_deco_piece'`, args: [] });
    expect(r.rows[0].prompt_pattern_fr).toBe("custom_edited");
    // And we still have 12 rows
    const cnt = await db.execute("SELECT COUNT(*) as cnt FROM content_templates");
    expect(Number(cnt.rows[0].cnt)).toBe(12);
  });
});

// ─── Route tests (mocked auth + DB + Anthropic) ─────────────────────────────

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

const MOCK_TEMPLATE = {
  id: 1,
  slug: "conseil_deco_piece",
  content_type: "education" as const,
  display_name_fr: "Conseil déco",
  display_name_en: "Deco tip",
  prompt_pattern_fr: "Rédige un post Facebook sur {{category}} dans un {{room}} en {{saison}}.",
  prompt_pattern_en: "Write a Facebook post about {{category}} in a {{room}} in {{saison}}.",
  image_strategy: "product",
  active: true,
  frequency_per_month: 2,
  scopes: ["mobilier_indoor"],
};

describe("POST /api/social/content/generate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 401 when not authenticated", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(false),
      getSessionRole: vi.fn().mockResolvedValue(null),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ templateSlug: "conseil_deco_piece", language: "fr" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 for reviewer role", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("reviewer"),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ templateSlug: "conseil_deco_piece", language: "fr" }));
    expect(res.status).toBe(403);
  });

  it("returns 400 when templateSlug is missing", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ language: "fr" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("templateSlug");
  });

  it("returns 400 when language is not fr", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ templateSlug: "conseil_deco_piece", language: "en" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 404 when template slug does not exist", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    vi.doMock("@/lib/database", () => ({
      getContentTemplateBySlug: vi.fn().mockResolvedValue(null),
      createFacebookDraft: vi.fn().mockResolvedValue(99),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ templateSlug: "does-not-exist", language: "fr" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("not found");
  });

  it("returns 422 when template is inactive", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    vi.doMock("@/lib/database", () => ({
      getContentTemplateBySlug: vi.fn().mockResolvedValue({ ...MOCK_TEMPLATE, active: false }),
      createFacebookDraft: vi.fn().mockResolvedValue(99),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ templateSlug: "conseil_deco_piece", language: "fr" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("not active");
  });

  it("returns 200 with draftId and postText on success", async () => {
    vi.doMock("@/lib/auth", () => ({
      isAuthenticated: vi.fn().mockResolvedValue(true),
      getSessionRole: vi.fn().mockResolvedValue("admin"),
    }));
    vi.doMock("@/lib/database", () => ({
      getContentTemplateBySlug: vi.fn().mockResolvedValue(MOCK_TEMPLATE),
      createFacebookDraft: vi.fn().mockResolvedValue(42),
      selectCompatibleHooks: vi.fn().mockResolvedValue([
        { id: 7, text: "Voici une astuce!", mode: "pool", categoryId: 1, language: "FR", productScopes: ["universal"], usedCount: 0, lastUsedAt: null },
      ]),
      getAnyProductSku: vi.fn().mockResolvedValue("01-0016"),
    }));
    vi.doMock("@/lib/hook-selector", () => ({
      mapProductTypeToScope: vi.fn().mockReturnValue("universal"),
    }));
    vi.doMock("@/lib/content-generator", () => ({
      getAnthropicClient: vi.fn().mockReturnValue({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "Super post généré par Claude !" }],
          }),
        },
      }),
    }));
    const { POST } = await import("@/app/api/social/content/generate/route");
    const res = await POST(makeRequest({ templateSlug: "conseil_deco_piece", language: "fr" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.draftId).toBe(42);
    expect(body.postText).toBe("Super post généré par Claude !");
    expect(body.templateSlug).toBe("conseil_deco_piece");
    expect(body.hookId).toBe(7);
    expect(body.vars).toHaveProperty("saison");
    expect(body.vars).toHaveProperty("mois");
    expect(body.vars).toHaveProperty("category");
    expect(body.vars).toHaveProperty("room");
  });
});
