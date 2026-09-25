/**
 * The morning-report count helpers, run through the REAL exported functions against the REAL
 * schema in an in-memory libsql database (same approach as database-critical-queries.test.ts),
 * so the status rules can't silently drift from the dashboard's own.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

// Must be set before database.ts is imported: it caches its client on first use.
process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let mod: typeof import("@/lib/database");

let guideSeq = 0;
async function guide(over: { status?: string; overall?: string | null; scheduled?: string | null; title?: string }) {
  guideSeq++;
  await db.execute({
    sql: `INSERT INTO guide_pages (aosom_category, shopify_collection_id, shopify_collection_title, status,
            overall_status, scheduled_publish_at, title)
          VALUES (?, ?, 'Coll', ?, ?, ?, ?)`,
    args: [
      `cat-${guideSeq}`,
      `coll-${guideSeq}`,
      over.status ?? "pending_review",
      over.overall === undefined ? "ready" : over.overall,
      over.scheduled ?? null,
      over.title ?? `Guide ${guideSeq}`,
    ],
  });
}

let queueSeq = 0;
async function queued(contentType: string, status: string, scheduledAt: string) {
  queueSeq++;
  await db.execute({
    sql: `INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status)
          VALUES (?, ?, 'facebook', '{}', ?, ?)`,
    args: [contentType, `c-${queueSeq}`, scheduledAt, status],
  });
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' UTC, `hours` from now. */
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

beforeAll(async () => {
  mod = await import("@/lib/database");
  db = await mod.ensureSchema();
});

beforeEach(async () => {
  for (const t of [
    "guide_pages", "publication_queue", "image_review_queue", "import_jobs", "notifications",
    "price_floor_incidents", "facebook_drafts", "blog_posts",
  ]) {
    await db.execute(`DELETE FROM ${t}`);
  }
  await db.execute(`DELETE FROM settings WHERE key IN ('price_audit_result', 'catalog_consistency_audit')`);
});

describe("countGuidesAwaitingApproval", () => {
  it("counts pending_review guides not yet scheduled, split ready / attention, with attention titles", async () => {
    await guide({ overall: "ready" });
    await guide({ overall: "ready" });
    await guide({ overall: "attention", title: "Guide balançoires" });
    await guide({ overall: null }); // not scored yet: pending but neither ready nor attention
    await guide({ overall: "attention", scheduled: "2026-10-01 13:00:00" }); // approved → excluded
    await guide({ status: "skipped_empty" });

    expect(await mod.countGuidesAwaitingApproval()).toEqual({
      pending: 4,
      ready: 2,
      attention: 1,
      attentionTitles: ["Guide balançoires"],
    });
  });

  it("returns zeros on an empty table", async () => {
    expect(await mod.countGuidesAwaitingApproval()).toEqual({ pending: 0, ready: 0, attention: 0, attentionTitles: [] });
  });
});

describe("countContentFormatVideos", () => {
  it("counts drafts, and approved videos due within the horizon (not past, not later, not other types)", async () => {
    await queued("assembly", "draft", at(100));
    await queued("before_after", "draft", at(1));
    await queued("demand_gen_ext", "pending", at(5)); // due soon
    await queued("assembly", "pending", at(48)); // due soon
    await queued("assembly", "pending", at(24 * 10)); // beyond 3 days
    await queued("assembly", "pending", at(-2)); // overdue slot: not "upcoming"
    await queued("sequential_ad", "draft", at(5)); // not a /content-formats video
    await queued("assembly", "published", at(-10));

    expect(await mod.countContentFormatVideos(3)).toEqual({ pendingApproval: 2, scheduledSoon: 2 });
  });
});

describe("countAwaitingOperator", () => {
  it("counts only the states that wait on Mat", async () => {
    await queued("sequential_ad", "draft", at(5));
    await queued("sequential_ad", "draft", at(6));
    await queued("sequential_ad", "pending", at(7)); // already approved
    const job = (id: string, status: string) =>
      db.execute({
        sql: `INSERT INTO import_jobs (id, group_key, product_data, status, created_at, updated_at)
              VALUES (?, ?, '{}', ?, '2026-09-25', '2026-09-25')`,
        args: [id, `g-${id}`, status],
      });
    await job("a", "reviewing");
    await job("live", "reviewing");
    await db.execute(`UPDATE import_jobs SET shopify_id = '900' WHERE id = 'live'`); // already on Shopify
    await job("b", "needs_review");
    await job("c", "done");
    await job("d", "pending"); // not generated yet — not waiting on Mat
    // facebook_drafts.sku is a FK to products.
    await db.execute(`INSERT OR IGNORE INTO products (sku, name, price) VALUES ('1', 'P1', 1), ('2', 'P2', 1)`);
    await db.execute(
      `INSERT INTO facebook_drafts (sku, trigger_type, language, post_text, status) VALUES
         ('1', 't', 'FR', 'x', 'draft'), ('2', 't', 'FR', 'x', 'approved')`,
    );

    expect(await mod.countAwaitingOperator()).toEqual({
      sequentialAds: 2,
      importsToPush: 1,
      importsNeedsReview: 1,
      socialDrafts: 1,
      blogDrafts: 0,
    });
  });
});

describe("countMorningReportAlerts", () => {
  it("reads the stored audits and counts open items", async () => {
    await mod.setSetting("price_audit_result", JSON.stringify({ belowFloorCount: 3, total: 100 }));
    await mod.setSetting("catalog_consistency_audit", JSON.stringify({ issues: [{}, {}] }));
    const now = Math.floor(Date.now() / 1000);
    await db.execute({
      sql: `INSERT INTO price_floor_incidents (sku, old_price, new_price, source, detected_at) VALUES
              ('a', 10, 5, 'sync', ?), ('b', 10, 5, 'sync', ?)`,
      args: [now - 3600, now - 3 * 86400],
    });
    await db.execute(
      `INSERT INTO image_review_queue (shopify_product_id, sku, current_url, proposed_url, status) VALUES
         ('1', 'a', 'u', 'v', 'pending'), ('2', 'b', 'u', 'v', 'applied')`,
    );
    await db.execute(
      `INSERT INTO import_jobs (id, group_key, product_data, status, created_at, updated_at)
       VALUES ('e', 'g-e', '{}', 'error', '2026-09-25', '2026-09-25')`,
    );
    await db.execute(`INSERT INTO notifications (type, title, message, read) VALUES ('x', 't', 'm', 0), ('x', 't', 'm', 1)`);

    expect(await mod.countMorningReportAlerts()).toEqual({
      priceBelowFloor: 3,
      priceFloorIncidents24h: 1,
      imagesPendingReview: 1,
      importErrors: 1,
      catalogIssues: 2,
      unreadNotifications: 1,
    });
  });

  it("treats a missing or corrupt audit setting as zero instead of throwing", async () => {
    await mod.setSetting("price_audit_result", "not json");
    const a = await mod.countMorningReportAlerts();
    expect(a.priceBelowFloor).toBe(0);
    expect(a.catalogIssues).toBe(0);
  });
});
