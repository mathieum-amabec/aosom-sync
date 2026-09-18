import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createClient, type Client } from "@libsql/client";

// ─── Mock factories (mirrors tests/job4-social.test.ts) ───────────────

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getUnusedUgcVideoCandidatesForSocial: vi.fn(),
  createFacebookDraft: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore" },
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {},
}));

vi.mock("@/lib/social-publisher", () => ({
  publishDraftToChannels: vi.fn(),
}));

import { runUgcVideoReinjection } from "@/jobs/job4-social";
import {
  getAllSettings,
  getUnusedUgcVideoCandidatesForSocial,
  createFacebookDraft,
  createNotification,
} from "@/lib/database";

function makeMsg(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const SETTINGS = {
  prompt_highlight_fr: "Post FR pour {product_name}",
  prompt_highlight_en: "Post EN for {product_name}",
  social_hashtags_fr: "#test",
  social_hashtags_en: "#test",
};

const CANDIDATE = {
  sku: "UGC-001",
  name: "Chaise de patio",
  price: 149.99,
  qty: 12,
  shopifyProductId: "9990001",
  shopifyHandle: "chaise-de-patio",
  videoUgc: "https://cdn.example.com/customer/CA/UGC-001.mp4",
  productType: "Patio & Garden > Patio Furniture > Patio Chairs",
};

describe("runUgcVideoReinjection (job)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS as never);
    vi.mocked(getUnusedUgcVideoCandidatesForSocial).mockResolvedValue([CANDIDATE] as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(42);
    vi.mocked(createNotification).mockResolvedValue(undefined as never);
    mockCreate.mockResolvedValue(makeMsg("Une belle chaise de patio."));
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates one draft per unused UGC candidate, with the video on both video fields", async () => {
    const results = await runUgcVideoReinjection(3);
    expect(results).toHaveLength(1);
    expect(results[0].draftId).toBe(42);

    const draftArg = vi.mocked(createFacebookDraft).mock.calls[0][0];
    expect(draftArg.sku).toBe("UGC-001");
    expect(draftArg.triggerType).toBe("ugc_video");
    expect(draftArg.videoUrl).toBe(CANDIDATE.videoUgc);
    expect(draftArg.reelsVideoUrl).toBe(CANDIDATE.videoUgc);
    // No image fields — this is a video-only post.
    expect(draftArg.imageUrls).toBeUndefined();
  });

  it("never sets a status field itself — facebook_drafts.status defaults to 'draft' at the DB layer", async () => {
    await runUgcVideoReinjection(1);
    const draftArg = vi.mocked(createFacebookDraft).mock.calls[0][0] as Record<string, unknown>;
    expect("status" in draftArg).toBe(false);
  });

  it("passes count through to the candidate query as the limit", async () => {
    await runUgcVideoReinjection(7);
    expect(vi.mocked(getUnusedUgcVideoCandidatesForSocial)).toHaveBeenCalledWith(7);
  });

  it("returns an empty array and skips notification content when the pool is exhausted", async () => {
    vi.mocked(getUnusedUgcVideoCandidatesForSocial).mockResolvedValue([]);
    const results = await runUgcVideoReinjection(3);
    expect(results).toEqual([]);
    expect(createFacebookDraft).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("creates one draft per candidate when several are returned", async () => {
    vi.mocked(getUnusedUgcVideoCandidatesForSocial).mockResolvedValue([
      CANDIDATE,
      { ...CANDIDATE, sku: "UGC-002", videoUgc: "https://cdn.example.com/customer/US/UGC-002.mp4" },
    ] as never);
    vi.mocked(createFacebookDraft).mockResolvedValueOnce(42).mockResolvedValueOnce(43);

    const results = await runUgcVideoReinjection(2);
    expect(results).toHaveLength(2);
    expect(createFacebookDraft).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});

// ─── getUnusedUgcVideoCandidatesForSocial SQL logic (direct, :memory:) ────
//
// Mirrors the products/facebook_drafts shape closely enough to exercise the real
// WHERE clause the function runs — not the full function (which connects to Turso
// via ensureSchema), matching this repo's existing convention for SQL-heavy
// database.ts functions (see "getEligibleHighlightCandidates SQL logic" above).
const TEST_DB_PATH = path.join(__dirname, "fixtures", "test-db-ugc.sqlite");

function setupTestDb(): Client {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  return createClient({ url: ":memory:" });
}

describe("getUnusedUgcVideoCandidatesForSocial SQL logic", () => {
  let db: Client;

  const SCHEMA = [
    `CREATE TABLE products (
      sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER,
      shopify_product_id TEXT, shopify_handle TEXT, video_ugc TEXT, product_type TEXT
    )`,
    `CREATE TABLE facebook_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, video_url TEXT
    )`,
  ];

  const QUERY = `SELECT p.sku FROM products p
    WHERE p.video_ugc IS NOT NULL AND TRIM(p.video_ugc) <> ''
      AND p.qty > 0
      AND p.shopify_handle IS NOT NULL AND TRIM(p.shopify_handle) <> ''
      AND (p.video_ugc LIKE '%/customer/CA/%' OR p.video_ugc LIKE '%/customer/US/%')
      AND NOT EXISTS (SELECT 1 FROM facebook_drafts fd WHERE fd.video_url = p.video_ugc)
    ORDER BY p.qty DESC`;

  beforeEach(async () => {
    db = setupTestDb();
    for (const stmt of SCHEMA) await db.execute(stmt);
  });
  afterEach(async () => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  it("excludes a video already referenced by an existing facebook_drafts row", async () => {
    await db.execute({
      sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["SKU-USED", "Used", 10, 5, "shop-1", "handle-1", "https://cdn.example.com/customer/CA/SKU-USED.mp4", "Patio"],
    });
    await db.execute({
      sql: `INSERT INTO facebook_drafts (sku, video_url) VALUES (?, ?)`,
      args: ["SKU-USED", "https://cdn.example.com/customer/CA/SKU-USED.mp4"],
    });
    const { rows } = await db.execute(QUERY);
    expect(rows).toHaveLength(0);
  });

  it("includes an eligible video not yet referenced by any draft", async () => {
    await db.execute({
      sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["SKU-NEW", "New", 10, 5, "shop-1", "handle-1", "https://cdn.example.com/customer/US/SKU-NEW.mp4", "Patio"],
    });
    const { rows } = await db.execute(QUERY);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).sku).toBe("SKU-NEW");
  });

  it("excludes a non-CA/US source (e.g. FR/Skeepers) even if otherwise eligible and unused", async () => {
    await db.execute({
      sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["SKU-FR", "FR source", 10, 5, "shop-1", "handle-1", "https://cdn.example.com/customer/FR/SKU-FR.mp4", "Patio"],
    });
    const { rows } = await db.execute(QUERY);
    expect(rows).toHaveLength(0);
  });

  it("excludes out-of-stock products even with an unused eligible video", async () => {
    await db.execute({
      sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["SKU-OOS", "Out of stock", 10, 0, "shop-1", "handle-1", "https://cdn.example.com/customer/CA/SKU-OOS.mp4", "Patio"],
    });
    const { rows } = await db.execute(QUERY);
    expect(rows).toHaveLength(0);
  });

  it("a rejected/published draft's video is still treated as used (exclusion is unconditional on status)", async () => {
    // getUnusedUgcVideoCandidatesForSocial's NOT EXISTS has no status filter by
    // design — once a clip has been queued once, it is never re-queued
    // automatically; a human can always re-trigger manually if truly desired.
    await db.execute({
      sql: `INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["SKU-REJECTED", "Rejected once", 10, 5, "shop-1", "handle-1", "https://cdn.example.com/customer/CA/SKU-REJECTED.mp4", "Patio"],
    });
    await db.execute({
      sql: `INSERT INTO facebook_drafts (sku, video_url) VALUES (?, ?)`,
      args: ["SKU-REJECTED", "https://cdn.example.com/customer/CA/SKU-REJECTED.mp4"],
    });
    const { rows } = await db.execute(QUERY);
    expect(rows).toHaveLength(0);
  });
});
