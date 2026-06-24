import { createClient, type Client, type Row, type InValue, type InStatement } from "@libsql/client";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { SyncRun, SyncLogEntry, ChangeType } from "@/types/sync";
import type { UserRole } from "@/lib/config";
import { DEFAULT_PUBLICATION_SCHEDULE, DEFAULT_BLOG_SCHEDULE } from "@/lib/config";
import type { AosomProduct } from "@/types/aosom";
import { startOfUtcDayEpoch, epochDaysAgo } from "@/lib/dashboard-metrics";
import { buildCatalogWhere, PRODUCT_HAS_DISCOUNT_SQL } from "@/lib/catalog-filters";
import { isSqliteUtc } from "@/lib/draft-scheduler";

let client: Client | null = null;

function getDb(): Client {
  if (!client) {
    const tursoUrl = process.env.TURSO_DATABASE_URL;
    const tursoToken = process.env.TURSO_AUTH_TOKEN;

    if (tursoUrl && tursoToken) {
      // Production: remote Turso
      client = createClient({ url: tursoUrl, authToken: tursoToken });
    } else if (tursoUrl || tursoToken) {
      // Partial config — one set without the other. Fail loud.
      throw new Error("Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (or neither for local SQLite)");
    } else {
      // Dev/local: SQLite file
      const dbDir = path.join(process.cwd(), "data");
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
      client = createClient({ url: `file:${path.join(dbDir, "aosom-sync.db")}` });
    }
  }
  return client;
}

/** Row → plain object helper. libsql Row objects support property access by column name. */
function rowToObj(row: Row): Record<string, unknown> {
  // libsql Row is iterable and supports named property access
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== "length" && !/^\d+$/.test(key))
  );
}

// ─── Schema Initialization ──────────────────────────────────────────

let schemaPromise: Promise<void> | null = null;

// Schema-init behind a swappable reference. Production always runs _initSchemaImpl;
// tests inject a fail-once-then-succeed impl (via __setInitSchemaImplForTests) to
// exercise the retry/reset contract below (#186) without a live DB.
let activeInitSchemaImpl: () => Promise<void> = _initSchemaImpl;

export async function initSchema(): Promise<void> {
  if (!schemaPromise) {
    // Reset the memoized promise on failure so the next caller retries instead of
    // re-throwing the cached rejection forever (issue #186: a transient init failure
    // otherwise wedged the process down until the next cold start).
    schemaPromise = activeInitSchemaImpl().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/**
 * Test-only (#186): swap the schema-init implementation and clear the memoized
 * promise so initSchema()'s retry-after-failure behaviour can be unit-tested.
 * Call with no argument to restore the real implementation.
 */
export function __setInitSchemaImplForTests(impl?: () => Promise<void>): void {
  activeInitSchemaImpl = impl ?? _initSchemaImpl;
  schemaPromise = null;
}

/** Test-only (#186): read the memoized schema promise (null after a failed init). */
export function __getSchemaPromiseForTests(): Promise<void> | null {
  return schemaPromise;
}

async function _initSchemaImpl(): Promise<void> {
  const db = getDb();

  // Run a schema-init batch, naming the step in the log before re-throwing on failure.
  // _initSchemaImpl's rejection is what initSchema() memoizes, so a labelled error turns
  // an otherwise opaque "schema init failed" into an actionable "which step broke" (#186).
  const runBatch = (label: string, stmts: InStatement[]) =>
    db.batch(stmts, "write").catch((err) => {
      console.error(`[initSchema] batch "${label}" failed:`, err);
      throw err;
    });

  // Schema statements inlined for Vercel compatibility (serverless has no access to src/ files at runtime)
  const schemaStatements = [
    `CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER, color TEXT, size TEXT,
      product_type TEXT, image1 TEXT, image2 TEXT, image3 TEXT, image4 TEXT, image5 TEXT,
      image6 TEXT, image7 TEXT, video TEXT, description TEXT, short_description TEXT,
      material TEXT, gtin TEXT, weight REAL, out_of_stock_expected TEXT, estimated_arrival TEXT,
      shopify_product_id TEXT, shopify_variant_id TEXT, shopify_handle TEXT,
      last_seen_at INTEGER, last_posted_at INTEGER,
      has_discount INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type)`,
    // NOTE: idx_products_has_discount (partial index on the precomputed "Avec rabais" flag)
    // is created LATER — after the has_discount column migration below — NOT in this batch.
    // On a pre-existing products table the column doesn't exist yet when this batch runs,
    // so a partial index referencing it threw "no such column: has_discount" and aborted
    // the entire schema init (→ db unreachable). See the post-migration block.
    `CREATE INDEX IF NOT EXISTS idx_products_shopify_id ON products(shopify_product_id)`,
    `CREATE INDEX IF NOT EXISTS idx_products_price ON products(price)`,
    `CREATE INDEX IF NOT EXISTS idx_products_qty ON products(qty)`,
    `CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`,
    `CREATE INDEX IF NOT EXISTS idx_products_name_sku ON products(name, sku)`,
    `CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, old_price REAL, new_price REAL,
      old_qty INTEGER, new_qty INTEGER, change_type TEXT,
      detected_at INTEGER DEFAULT (strftime('%s','now')), applied_to_shopify INTEGER DEFAULT 0,
      FOREIGN KEY (sku) REFERENCES products(sku)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_price_history_sku ON price_history(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_price_history_change_type ON price_history(change_type)`,
    `CREATE INDEX IF NOT EXISTS idx_price_history_detected_at ON price_history(detected_at)`,
    // Composite (sku, detected_at): serves the per-SKU correlated "Avec rabais" subquery
    // (catalog-filters PRODUCT_HAS_DISCOUNT_SQL) and the last_price CTE — both seek by sku
    // then need the newest row by detected_at. The #1 catalog read-cost path on Turso.
    `CREATE INDEX IF NOT EXISTS idx_price_history_sku_detected ON price_history(sku, detected_at)`,
    // Composite (change_type, detected_at): serves the dashboard new_product count and the
    // best_sellers/price_drop aggregates, which filter change_type AND a detected_at window.
    `CREATE INDEX IF NOT EXISTS idx_price_history_changetype_detected ON price_history(change_type, detected_at)`,
    `CREATE TABLE IF NOT EXISTS facebook_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, trigger_type TEXT NOT NULL,
      language TEXT NOT NULL, post_text TEXT NOT NULL, image_path TEXT, image_url TEXT,
      image_urls TEXT, video_url TEXT, reels_video_url TEXT,
      old_price REAL, new_price REAL, status TEXT DEFAULT 'draft', scheduled_at INTEGER,
      published_at INTEGER, facebook_post_id TEXT,
      post_text_en TEXT, channels TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (sku) REFERENCES products(sku)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_facebook_drafts_sku ON facebook_drafts(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_facebook_drafts_status ON facebook_drafts(status)`,
    // Composite (status, created_at): the drafts review list (getDraftsForReview) filters by
    // status and ORDER BY created_at DESC, and the dashboard stale-draft scan filters
    // status IN (...) AND created_at < ?. A (status, trigger_type) index does NOT help — the
    // planner only seeks status then post-filters trigger_type (verified via EXPLAIN QUERY PLAN);
    // created_at as the 2nd key serves both the range filter and the sort.
    `CREATE INDEX IF NOT EXISTS idx_facebook_drafts_status_created ON facebook_drafts(status, created_at)`,
    // Migrations for tables created before multi-channel columns existed (no-op if already present)
    `CREATE TABLE IF NOT EXISTS social_autopost_counter (
      day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0
    )`,
    // Per-ISO-week count of blog articles auto-published, for the weekly cap. Keyed by
    // isoWeekKey() ('YYYY-Www'); old weeks just sit dormant (negligible row count).
    `CREATE TABLE IF NOT EXISTS blog_publish_counter (
      week TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL,
      message TEXT NOT NULL, read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)`,
    `CREATE TABLE IF NOT EXISTS product_type_counts (
      type TEXT PRIMARY KEY, count INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS collection_mappings (
      aosom_category TEXT NOT NULL,
      collection_role TEXT NOT NULL DEFAULT 'sub' CHECK(collection_role IN ('main', 'sub')),
      shopify_collection_id TEXT NOT NULL,
      shopify_collection_title TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now')),
      PRIMARY KEY (aosom_category, collection_role)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin', 'reviewer')),
      created_at INTEGER DEFAULT (strftime('%s','now')),
      last_login_at INTEGER
    )`,
    /* content_type: 'education' | 'inspiration' | 'engagement' | 'seasonal'
       Constraint enforced at application layer — SQLite ALTER TABLE cannot add CHECK constraints */
    `CREATE TABLE IF NOT EXISTS content_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL,
      display_name_fr TEXT NOT NULL,
      display_name_en TEXT NOT NULL,
      prompt_pattern_fr TEXT NOT NULL,
      prompt_pattern_en TEXT NOT NULL,
      image_strategy TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      frequency_per_month INTEGER NOT NULL DEFAULT 2,
      scopes TEXT NOT NULL DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_content_templates_slug ON content_templates(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_content_templates_type ON content_templates(content_type)`,
    `CREATE TABLE IF NOT EXISTS content_generation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_slug TEXT NOT NULL,
      draft_id INTEGER,
      language TEXT NOT NULL,
      category_filter TEXT,
      success INTEGER NOT NULL,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // Single-row cache for the pre-fetched Aosom CSV blob. CHECK(id=1) enforces singleton.
    `CREATE TABLE IF NOT EXISTS csv_blob_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      blob_url TEXT NOT NULL,
      blob_key TEXT NOT NULL,
      csv_size_bytes INTEGER NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      upload_duration_ms INTEGER NOT NULL DEFAULT 0,
      download_duration_ms INTEGER NOT NULL DEFAULT 0
    )`,
    // ─── Hook Pool (v0.1.20) ─────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS content_hook_categories (
      id INTEGER PRIMARY KEY,
      name_fr TEXT NOT NULL,
      name_en TEXT NOT NULL,
      description TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS content_hooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES content_hook_categories(id),
      language TEXT NOT NULL CHECK(language IN ('FR', 'EN')),
      text TEXT NOT NULL,
      -- JSON array of scope strings this hook applies to (e.g. ["universal"] or ["outdoor_patio","mobilier_indoor"])
      product_scopes TEXT NOT NULL DEFAULT '["universal"]',
      mode TEXT NOT NULL DEFAULT 'pool' CHECK(mode IN ('pool', 'generative_seeded')),
      used_count INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_content_hooks_category ON content_hooks(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_content_hooks_lang ON content_hooks(language)`,
    `CREATE INDEX IF NOT EXISTS idx_content_hooks_used ON content_hooks(used_count, last_used_at)`,
    // UNIQUE prevents double-seeding on concurrent cold starts
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_content_hooks_lang_text ON content_hooks(language, text)`,
    `CREATE TABLE IF NOT EXISTS hook_usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hook_id INTEGER NOT NULL REFERENCES content_hooks(id),
      draft_id INTEGER REFERENCES facebook_drafts(id),
      used_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_hook_usage_hook ON hook_usage_history(hook_id)`,
    `CREATE INDEX IF NOT EXISTS idx_hook_usage_at ON hook_usage_history(used_at DESC)`,
  ];

  // Batch all schema + legacy table creation in a single round trip
  const legacyStatements = [
    `CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      total_products INTEGER DEFAULT 0, created INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0, archived INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0, error_messages TEXT DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY, sync_run_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      shopify_product_id TEXT, sku TEXT NOT NULL, action TEXT NOT NULL,
      field TEXT NOT NULL, old_value TEXT, new_value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY, group_key TEXT UNIQUE NOT NULL, product_data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', content TEXT, shopify_id TEXT,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    // video_jobs: queue of product/lifestyle/promo video generations. The generation
    // engines (ffmpeg/kling/creatomate) land in a follow-up PR; this table backs the
    // dashboard "Vidéos" UI skeleton. created_at/updated_at are unix seconds.
    `CREATE TABLE IF NOT EXISTS video_jobs (
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
    // video_demand_gen: durable index of the rendered+uploaded Demand Gen video
    // assets (blob_url is the Vercel Blob source). One row per (sku, ratio,
    // duration). meta_video_id / youtube_video_id + *_status are filled later by
    // the ad-push jobs (Meta advideos file_url ingest, YouTube upload for Google
    // Demand Gen). created_at/updated_at are unix seconds. See scripts/load-demand-gen-db.mjs.
    `CREATE TABLE IF NOT EXISTS video_demand_gen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL,
      shopify_product_id TEXT,
      title_fr TEXT,
      ratio TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      blob_path TEXT NOT NULL,
      blob_url TEXT NOT NULL,
      bytes INTEGER,
      meta_video_id TEXT,
      meta_status TEXT,
      youtube_video_id TEXT,
      youtube_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(sku, ratio, duration_sec)
    )`,
    `CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      sku TEXT NOT NULL,
      shopify_product_id TEXT,
      price_at_signup REAL NOT NULL,
      created_at INTEGER NOT NULL,
      notified_at INTEGER,
      confirmed INTEGER DEFAULT 0,
      confirm_token TEXT,
      token_expires_at INTEGER,
      UNIQUE(email, sku)
    )`,
    // back_in_stock_waitlist: storefront "notify me when back in stock" signups.
    // One row per (email, sku); notified_at stamped once the restock email fires
    // (Job 1 detectChanges → notifyBackInStockWaitlist). Double opt-in (CASL):
    // confirmed=0 until the recipient clicks the emailed token, and only confirmed
    // rows are ever emailed on restock — mirrors price_alerts.
    `CREATE TABLE IF NOT EXISTS back_in_stock_waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      sku TEXT NOT NULL,
      shopify_product_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      notified_at INTEGER,
      confirmed INTEGER DEFAULT 0,
      confirm_token TEXT,
      token_expires_at INTEGER,
      UNIQUE(email, sku)
    )`,
    // cron_runs: one row per cron invocation (last-run status surfaced on the dashboard).
    `CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
      ran_at INTEGER NOT NULL
    )`,
    // feed_syncs: one row per Google/Meta/Pinterest feed fetch (last successful fetch on the dashboard).
    `CREATE TABLE IF NOT EXISTS feed_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_type TEXT NOT NULL, item_count INTEGER, status TEXT NOT NULL, error TEXT,
      fetched_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_logs_run ON sync_logs(sync_run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_logs_sku ON sync_logs(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_sync_runs_date ON sync_runs(started_at)`,
    `CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status)`,
    `CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status)`,
    `CREATE INDEX IF NOT EXISTS idx_video_jobs_created_at ON video_jobs(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_price_alerts_sku ON price_alerts(sku)`,
    `CREATE INDEX IF NOT EXISTS idx_price_alerts_pending ON price_alerts(notified_at)`,
    // (sku, notified_at): serves getPendingWaitlist — seek by sku, filter notified_at IS NULL.
    `CREATE INDEX IF NOT EXISTS idx_waitlist_sku_pending ON back_in_stock_waitlist(sku, notified_at)`,
    `CREATE INDEX IF NOT EXISTS idx_cron_runs_name_at ON cron_runs(name, ran_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_feed_syncs_type_at ON feed_syncs(feed_type, fetched_at DESC)`,
    // publication_queue: unified scheduling queue for social posts, Shopify product
    // drafts, and blog articles. scheduled_at/created_at/published_at are SQLite
    // datetime() TEXT ('YYYY-MM-DD HH:MM:SS' UTC) — distinct from facebook_drafts which
    // uses unix-seconds integers. payload is the JSON-stringified content the consumer
    // cron publishes for the slot. CHECK constraints reject typo'd enum values that would
    // otherwise make a row invisible to every status-filtered query.
    `CREATE TABLE IF NOT EXISTS publication_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL CHECK (content_type IN ('social', 'draft', 'blog', 'video')),
      content_id TEXT NOT NULL,      -- ID of the source draft/post
      platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'both', 'shopify_blog')),
      payload TEXT NOT NULL,         -- JSON-stringified content
      scheduled_at TEXT NOT NULL,    -- SQLite datetime TEXT of the slot (UTC)
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'cancelled')),
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      published_at TEXT
    )`,
    // Composite (status, scheduled_at): serves the consumer cron's "due pending items,
    // oldest slot first" scan (getNextPending) — seek by status then order by scheduled_at.
    `CREATE INDEX IF NOT EXISTS idx_publication_queue_status_scheduled ON publication_queue(status, scheduled_at)`,
    // Partial UNIQUE (platform, scheduled_at) over ACTIVE rows only: enforces "one active
    // item per platform per slot" as a hard integrity backstop, so the read-compute-insert
    // in /api/queue/add can't silently double-book a slot under concurrent requests. failed/
    // cancelled rows drop out of the index, freeing their slot for rebooking.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_queue_active_slot ON publication_queue(platform, scheduled_at) WHERE status IN ('pending', 'publishing', 'published')`,
  ];

  const allStatements = [...schemaStatements, ...legacyStatements];
  await runBatch("schema+legacy DDL", allStatements.map(sql => ({ sql, args: [] })));

  // publication_queue.content_type CHECK migration: ('social','draft','blog') → +'video'.
  // SQLite can't ALTER a CHECK, so rebuild the table when the live DDL still lacks 'video'.
  // Guarded on the stored table SQL → runs at most once, and is a no-op on fresh DBs (whose
  // CREATE already includes 'video'). runBatch is transactional, so the swap is atomic.
  const pqDef = await db.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='publication_queue'`,
  );
  const pqSql = pqDef.rows[0] ? String((pqDef.rows[0] as unknown as Record<string, unknown>).sql ?? "") : "";
  if (pqSql && !pqSql.includes("'video'")) {
    await runBatch("publication_queue content_type CHECK +video", [
      // Drop any leftover scratch table from a crashed prior attempt so the rebuild is re-runnable.
      { sql: `DROP TABLE IF EXISTS publication_queue_new`, args: [] },
      { sql: `CREATE TABLE publication_queue_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_type TEXT NOT NULL CHECK (content_type IN ('social', 'draft', 'blog', 'video')),
        content_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'both', 'shopify_blog')),
        payload TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'publishing', 'published', 'failed', 'cancelled')),
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        published_at TEXT
      )`, args: [] },
      { sql: `INSERT INTO publication_queue_new (id, content_type, content_id, platform, payload, scheduled_at, status, error, created_at, published_at)
              SELECT id, content_type, content_id, platform, payload, scheduled_at, status, error, created_at, published_at FROM publication_queue`, args: [] },
      { sql: `DROP TABLE publication_queue`, args: [] },
      { sql: `ALTER TABLE publication_queue_new RENAME TO publication_queue`, args: [] },
      // Indexes were dropped with the old table — recreate both on the rebuilt one.
      { sql: `CREATE INDEX IF NOT EXISTS idx_publication_queue_status_scheduled ON publication_queue(status, scheduled_at)`, args: [] },
      { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_queue_active_slot ON publication_queue(platform, scheduled_at) WHERE status IN ('pending', 'publishing', 'published')`, args: [] },
    ]);
  }

  // Column migrations for facebook_drafts (post_text_en, channels) — SQLite can't IF NOT EXISTS on ALTER
  const info = await db.execute(`PRAGMA table_info(facebook_drafts)`);
  const cols = new Set(info.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  const alters: string[] = [];
  if (!cols.has("post_text_en")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN post_text_en TEXT`);
  if (!cols.has("channels")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN channels TEXT`);
  if (!cols.has("image_urls")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN image_urls TEXT`);
  if (!cols.has("video_url")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN video_url TEXT`);
  // reels_video_url: vertical 9:16 video for Instagram Reels (square video_url stays for Facebook)
  if (!cols.has("reels_video_url")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN reels_video_url TEXT`);
  // video_path: legacy column kept for existing rows. Rendered clips now live in
  // video_jobs.video_path (served via /api/video-serve/[id]); nothing writes this.
  if (!cols.has("video_path")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN video_path TEXT`);
  // content_type: distinguishes product posts from informative/entertaining/engagement content
  if (!cols.has("content_type")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN content_type TEXT NOT NULL DEFAULT 'product'`);
  // hook_id: FK to content_hooks — which hook seeded this draft's caption
  if (!cols.has("hook_id")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN hook_id INTEGER REFERENCES content_hooks(id)`);
  if (!cols.has("approved_at")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN approved_at INTEGER`);
  if (!cols.has("reviewed_by")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN reviewed_by TEXT`);
  if (!cols.has("review_notes")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN review_notes TEXT`);
  if (!cols.has("publish_error")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN publish_error TEXT`);
  // Unsplash image + attribution for content_template drafts (no product image of their own)
  if (!cols.has("unsplash_image_url")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN unsplash_image_url TEXT`);
  if (!cols.has("unsplash_photographer")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN unsplash_photographer TEXT`);
  if (!cols.has("unsplash_photographer_url")) alters.push(`ALTER TABLE facebook_drafts ADD COLUMN unsplash_photographer_url TEXT`);

  // checkpoint_data on sync_runs: stores per-chunk progress for Phase 2 chunked push
  // timing_ms on sync_runs: per-phase duration map written incrementally (survives SIGKILL diagnosis)
  const syncRunsInfo = await db.execute(`PRAGMA table_info(sync_runs)`);
  const syncRunCols = new Set(syncRunsInfo.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  if (!syncRunCols.has("checkpoint_data")) {
    alters.push(`ALTER TABLE sync_runs ADD COLUMN checkpoint_data TEXT`);
  }
  if (!syncRunCols.has("timing_ms")) {
    alters.push(`ALTER TABLE sync_runs ADD COLUMN timing_ms TEXT`);
  }
  // shopify_handle on products: storefront handle for /products/{handle} deep links.
  const productsInfo = await db.execute(`PRAGMA table_info(products)`);
  const productCols = new Set(productsInfo.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  if (!productCols.has("shopify_handle")) {
    alters.push(`ALTER TABLE products ADD COLUMN shopify_handle TEXT`);
  }
  // has_discount: precomputed rabais flag (see recomputeHasDiscount). Backfilled once
  // below when the column is first added; refreshed every sync thereafter.
  const hasDiscountColExisted = productCols.has("has_discount");
  if (!hasDiscountColExisted) {
    alters.push(`ALTER TABLE products ADD COLUMN has_discount INTEGER DEFAULT 0`);
  }

  // price_alerts double opt-in columns (table shipped in #99 without them).
  const priceAlertsInfo = await db.execute(`PRAGMA table_info(price_alerts)`);
  const priceAlertCols = new Set(priceAlertsInfo.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  if (!priceAlertCols.has("confirmed")) {
    alters.push(`ALTER TABLE price_alerts ADD COLUMN confirmed INTEGER DEFAULT 0`);
  }
  if (!priceAlertCols.has("confirm_token")) {
    alters.push(`ALTER TABLE price_alerts ADD COLUMN confirm_token TEXT`);
  }
  if (!priceAlertCols.has("token_expires_at")) {
    alters.push(`ALTER TABLE price_alerts ADD COLUMN token_expires_at INTEGER`);
  }

  if (alters.length > 0) {
    await runBatch("column ALTERs", alters.map(sql => ({ sql, args: [] })));
  }

  // has_discount partial index — created HERE, after the ALTER above guarantees the column
  // exists (fresh DBs get it from CREATE TABLE; existing DBs from the ALTER). Creating it in
  // the early schemaStatements batch threw "no such column: has_discount" on the pre-existing
  // production table (column not added yet) and aborted schema init. Idempotent (IF NOT EXISTS).
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_has_discount ON products(has_discount) WHERE has_discount = 1`);

  // One-time backfill of products.has_discount when the column was just added. Uses the
  // local `db` (not recomputeHasDiscount → ensureSchema) to avoid awaiting the in-flight
  // schema promise. Refreshed every sync thereafter via recomputeHasDiscount().
  if (!hasDiscountColExisted) {
    await db.execute(`UPDATE products SET has_discount = CASE WHEN ${PRODUCT_HAS_DISCOUNT_SQL} THEN 1 ELSE 0 END`);
  }

  // content_templates column migration (frequency_per_month + scopes + mode)
  const ctInfo = await db.execute(`PRAGMA table_info(content_templates)`);
  const ctCols = new Set(ctInfo.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  const ctAlters: string[] = [];
  if (!ctCols.has("frequency_per_month")) {
    ctAlters.push(`ALTER TABLE content_templates ADD COLUMN frequency_per_month INTEGER NOT NULL DEFAULT 2`);
  }
  if (!ctCols.has("scopes")) {
    ctAlters.push(`ALTER TABLE content_templates ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!ctCols.has("mode")) {
    ctAlters.push(`ALTER TABLE content_templates ADD COLUMN mode TEXT NOT NULL DEFAULT 'hook_seeded'`);
  }
  if (ctAlters.length > 0) {
    await runBatch("content_templates ALTERs", ctAlters.map(sql => ({ sql, args: [] })));
  }

  // One-shot: assign mode values + update generative prompts (runs only when mode column is new)
  if (!ctCols.has("mode")) {
    const GENERATIVE_SEEDED_SLUGS = [
      "conseil_deco_piece", "guide_achat_categorie", "astuces_entretien",
      "inspiration_ambiance_maison", "inspiration_vie_outdoor", "inspiration_animaux",
      "inspiration_famille", "saisonnier_outdoor", "saisonnier_indoor",
    ];
    const HOOK_SEEDED_SLUGS = ["sondage_debat", "devine_quizz", "aide_choisir"];
    const GENERATIVE_PROMPT_REPLACEMENTS: { slug: string; replacement: string }[] = [
      { slug: "conseil_deco_piece",
        replacement: "Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque un secret de déco, une erreur courante ou une révélation sur l'aménagement intérieur." },
      { slug: "guide_achat_categorie",
        replacement: "Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque ce que les gens oublient souvent avant d'acheter en {{category}}. Ton de conseil bienveillant." },
      { slug: "astuces_entretien",
        replacement: "Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque un secret de pro ou une erreur d'entretien à éviter. Pratique et utile." },
      { slug: "inspiration_ambiance_maison",
        replacement: "Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, crée une image mentale ou sensorielle d'un intérieur réussi. Poétique, désirable." },
      { slug: "inspiration_vie_outdoor",
        replacement: "Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque un moment de vie idéal à l'extérieur en {{season}} au Québec. Vivant et sensoriel." },
      { slug: "inspiration_animaux",
        replacement: "Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque un moment tendre et reconnaissable avec un animal de compagnie." },
      { slug: "inspiration_famille",
        replacement: "Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque une scène familière et complice de la vie de famille à la maison." },
      { slug: "saisonnier_outdoor",
        replacement: "Commence par une accroche percutante que tu génères toi-même — 8-15 mots, évoque l'anticipation ou l'émotion propre à {{season}} pour les Québécois dehors." },
      { slug: "saisonnier_indoor",
        replacement: "Commence par une accroche évocatrice que tu génères toi-même — 8-15 mots, évoque l'ambiance saisonnière intérieure au Québec en {{season}}." },
    ];
    await runBatch("content_templates mode seed", [
      ...GENERATIVE_SEEDED_SLUGS.map(slug => ({
        sql: `UPDATE content_templates SET mode = 'generative_seeded' WHERE slug = ?`,
        args: [slug] as import("@libsql/client").InValue[],
      })),
      ...HOOK_SEEDED_SLUGS.map(slug => ({
        sql: `UPDATE content_templates SET mode = 'hook_seeded' WHERE slug = ?`,
        args: [slug] as import("@libsql/client").InValue[],
      })),
      ...GENERATIVE_PROMPT_REPLACEMENTS.map(({ slug, replacement }) => ({
        sql: `UPDATE content_templates SET prompt_pattern_fr = REPLACE(prompt_pattern_fr, 'Commence exactement par cette accroche: {{hook}}', ?) WHERE slug = ?`,
        args: [replacement, slug] as import("@libsql/client").InValue[],
      })),
    ]);
  }

  // Tutoiement v1 — add mandatory tutoiement constraint to 6 inspiration/seasonal templates.
  // Gated on a settings flag so it runs exactly once per database, regardless of mode column state.
  const tutoiementDone = await db.execute(`SELECT value FROM settings WHERE key = 'tutoiement_v1_migrated' LIMIT 1`);
  if (tutoiementDone.rows.length === 0) {
    const TUTOIEMENT_SLUGS = [
      "inspiration_ambiance_maison", "inspiration_vie_outdoor", "inspiration_animaux",
      "inspiration_famille", "saisonnier_outdoor", "saisonnier_indoor",
    ];
    await runBatch("tutoiement v1", [
      ...TUTOIEMENT_SLUGS.map(slug => ({
        sql: `UPDATE content_templates SET prompt_pattern_fr = REPLACE(prompt_pattern_fr, 'Contraintes:', 'Contraintes:' || char(10) || '- Tutoiement OBLIGATOIRE (tu/te/ton) dans tout le post — corps ET CTA. Jamais de vous/votre/vos.') WHERE slug = ?`,
        args: [slug] as import("@libsql/client").InValue[],
      })),
      {
        sql: `UPDATE content_templates SET prompt_pattern_fr = REPLACE(prompt_pattern_fr, 'C''est quoi votre activité préférée en famille à la maison?', 'C''est quoi ton activité préférée en famille à la maison?') WHERE slug = 'inspiration_famille'`,
        args: [] as import("@libsql/client").InValue[],
      },
    ]);
    // Flag written after updates succeed — separate statement so partial batch failure leaves flag unset
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES ('tutoiement_v1_migrated', '1')`);
  }

  // Idempotent users.role migration — ALTER TABLE ADD COLUMN with a default.
  // Existing rows get 'admin' to preserve backwards compatibility for the
  // original AUTH_PASSWORD-seeded admin user.
  const usersInfo = await db.execute(`PRAGMA table_info(users)`);
  const userCols = new Set(usersInfo.rows.map((r) => String((r as unknown as Record<string, unknown>).name)));
  if (!userCols.has("role")) {
    await db.execute(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
  }
  // Backfill image_urls from legacy single image_url, one-shot idempotent.
  if (!cols.has("image_urls")) {
    await db.execute(
      `UPDATE facebook_drafts SET image_urls = json_array(image_url) WHERE image_urls IS NULL AND image_url IS NOT NULL`
    );
  }

  // Default settings — batch insert
  const defaultSettings: [string, string][] = [
    ['social_default_language', 'FR'],
    ['social_post_frequency', '1'],
    ['social_preferred_hour', '13'],
    ['social_price_drop_threshold', '10'],
    ['social_min_days_between_reposts', '30'],
    ['social_hashtags_fr', '#jardinage #patio #mobilierexterieur #canada'],
    ['social_hashtags_en', '#garden #patio #outdoorfurniture #canada'],
    ['social_include_price', 'true'],
    ['social_include_link', 'true'],
    ['social_tone', 'promotional'],
    ['prompt_new_product_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook engageant pour ce nouveau produit : {product_name}. Prix : {price}$. Ton : enthousiaste et accessible. Maximum 150 mots. Termine avec les hashtags : {hashtags}'],
    ['prompt_new_product_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write an engaging Facebook post for this new product: {product_name}. Price: {price}$. Tone: enthusiastic and approachable. Maximum 150 words. End with hashtags: {hashtags}'],
    ['prompt_price_drop_fr', 'Tu es un expert en marketing promotionnel québécois. Rédige un post Facebook pour annoncer une baisse de prix sur : {product_name}. Ancien prix : {old_price}$. Nouveau prix : {new_price}$. Mets en valeur les économies. Maximum 120 mots. Hashtags : {hashtags}'],
    ['prompt_price_drop_en', 'You are a Canadian promotional marketing expert. Write a Facebook post announcing a price drop on: {product_name}. Old price: {old_price}$. New price: {new_price}$. Highlight the savings. Maximum 120 words. Hashtags: {hashtags}'],
    ['prompt_highlight_fr', 'Tu es un expert en marketing pour une boutique québécoise de mobilier extérieur. Rédige un post Facebook pour mettre en valeur ce produit populaire de notre catalogue : {product_name}. Prix : {price}$. Stock disponible : {qty} unités. Maximum 130 mots. Hashtags : {hashtags}'],
    ['prompt_highlight_en', 'You are a marketing expert for a Canadian outdoor furniture store. Write a Facebook post highlighting this popular product from our catalogue: {product_name}. Price: {price}$. Stock: {qty} units available. Maximum 130 words. Hashtags: {hashtags}'],
    ['social_accent_color', '#2563eb'],
    ['social_text_color', '#ffffff'],
    ['social_store_display_name', ''],
    ['social_banner_opacity', '75'],
    ['social_logo_position', 'bottom-right'],
    ['publication_schedule', JSON.stringify(DEFAULT_PUBLICATION_SCHEDULE)],
    ['blog_schedule', JSON.stringify(DEFAULT_BLOG_SCHEDULE)],
  ];

  await runBatch(
    "default settings",
    defaultSettings.map(([key, value]) => ({
      sql: `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
      args: [key, value],
    })),
  );

  // Migrate content templates to megastore spec (one-shot: detects old slugs by checking for new slug)
  const ctMigrateCheck = await db.execute(
    `SELECT slug FROM content_templates WHERE slug = 'conseil_deco_piece' LIMIT 1`
  );
  if (ctMigrateCheck.rows.length === 0) {
    const { MEGASTORE_TEMPLATES } = await import("@/lib/seed/content-templates-megastore");
    await db.execute("DELETE FROM content_templates");
    await runBatch(
      "megastore templates seed",
      MEGASTORE_TEMPLATES.map((t) => ({
        sql: `INSERT INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes, mode)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          t.slug, t.content_type, t.display_name_fr, t.display_name_en,
          t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
          t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes), t.mode,
        ],
      })),
    );
  }

  // Idempotent: ensure clickbait templates exist even on already-seeded DBs.
  // The megastore seed above runs once (guarded by the conseil_deco_piece slug),
  // so new templates added later need their own INSERT OR IGNORE pass keyed on
  // the unique slug. Safe to run on every cold start.
  {
    const { CLICKBAIT_TEMPLATES } = await import("@/lib/seed/content-templates-megastore");
    await runBatch(
      "clickbait templates seed",
      CLICKBAIT_TEMPLATES.map((t) => ({
        sql: `INSERT OR IGNORE INTO content_templates
              (slug, content_type, display_name_fr, display_name_en,
               prompt_pattern_fr, prompt_pattern_en, image_strategy,
               active, frequency_per_month, scopes, mode)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          t.slug, t.content_type, t.display_name_fr, t.display_name_en,
          t.prompt_pattern_fr, t.prompt_pattern_en, t.image_strategy,
          t.active ? 1 : 0, t.frequency_per_month, JSON.stringify(t.scopes), t.mode,
        ],
      })),
    );
  }

  // Enable WAL and foreign keys for local SQLite
  if (!process.env.TURSO_DATABASE_URL) {
    await db.execute("PRAGMA journal_mode = WAL");
    await db.execute("PRAGMA foreign_keys = ON");
  }

  // Seed hook pool on first run (no-op if already seeded)
  await seedHooksIfEmpty();

}

/** Ensure schema is initialized before any query */
export async function ensureSchema(): Promise<Client> {
  await initSchema();
  return getDb();
}

// ─── Products (replaces catalog_snapshots) ───────────────────────────

export interface ProductRow {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  size: string;
  product_type: string;
  image1: string;
  image2: string;
  image3: string;
  image4: string;
  image5: string;
  image6: string;
  image7: string;
  video: string;
  description: string;
  short_description: string;
  material: string;
  gtin: string;
  weight: number;
  out_of_stock_expected: string;
  estimated_arrival: string;
  shopify_product_id: string | null;
  shopify_variant_id: string | null;
  shopify_handle: string | null;
  last_seen_at: number;
  last_posted_at: number | null;
  created_at: number;
  /** old_price of the most recent price change (price_drop/price_increase) for this SKU,
   * or null if the SKU never changed price. The catalog UI compares it against `price` to
   * render the ▼/▲ movement badge. Only populated by getProducts (catalog browse). */
  prev_price?: number | null;
}

function rowToProduct(row: Row): ProductRow {
  const o = rowToObj(row);
  return {
    sku: (o.sku as string) || "",
    name: (o.name as string) || "",
    price: Number(o.price) || 0,
    qty: Number(o.qty) || 0,
    color: (o.color as string) || "",
    size: (o.size as string) || "",
    product_type: (o.product_type as string) || "",
    image1: (o.image1 as string) || "",
    image2: (o.image2 as string) || "",
    image3: (o.image3 as string) || "",
    image4: (o.image4 as string) || "",
    image5: (o.image5 as string) || "",
    image6: (o.image6 as string) || "",
    image7: (o.image7 as string) || "",
    video: (o.video as string) || "",
    description: (o.description as string) || "",
    short_description: (o.short_description as string) || "",
    material: (o.material as string) || "",
    gtin: (o.gtin as string) || "",
    weight: Number(o.weight) || 0,
    out_of_stock_expected: (o.out_of_stock_expected as string) || "",
    estimated_arrival: (o.estimated_arrival as string) || "",
    shopify_product_id: (o.shopify_product_id as string) || null,
    shopify_variant_id: (o.shopify_variant_id as string) || null,
    shopify_handle: (o.shopify_handle as string) || null,
    last_seen_at: Number(o.last_seen_at) || 0,
    last_posted_at: o.last_posted_at != null ? Number(o.last_posted_at) : null,
    created_at: Number(o.created_at) || 0,
    prev_price: o.prev_price != null ? Number(o.prev_price) : null,
  };
}

export async function refreshProducts(products: Omit<ProductRow, "shopify_product_id" | "shopify_variant_id" | "shopify_handle" | "last_posted_at" | "created_at">[]): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const stmts = products.map((p) => ({
    sql: `INSERT INTO products (sku, name, price, qty, color, size, product_type,
      image1, image2, image3, image4, image5, image6, image7, video,
      description, short_description, material, gtin, weight,
      out_of_stock_expected, estimated_arrival, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      name=excluded.name, price=excluded.price, qty=excluded.qty,
      color=excluded.color, size=excluded.size, product_type=excluded.product_type,
      image1=excluded.image1, image2=excluded.image2, image3=excluded.image3,
      image4=excluded.image4, image5=excluded.image5, image6=excluded.image6,
      image7=excluded.image7, video=excluded.video,
      description=excluded.description, short_description=excluded.short_description,
      material=excluded.material, gtin=excluded.gtin, weight=excluded.weight,
      out_of_stock_expected=excluded.out_of_stock_expected,
      estimated_arrival=excluded.estimated_arrival, last_seen_at=excluded.last_seen_at`,
    args: [
      p.sku, p.name, p.price, p.qty, p.color, p.size, p.product_type,
      p.image1, p.image2, p.image3, p.image4, p.image5, p.image6, p.image7,
      p.video, p.description, p.short_description, p.material, p.gtin, p.weight,
      p.out_of_stock_expected, p.estimated_arrival, now,
    ],
  }));

  // Bench 26 avril: batch_size=1000 is 4× faster than 100 on Turso
  // (super-linear efficiency from internal SQLite transaction grouping)
  // Turso HTTP API cap: ~8MB/request. At ~427KB/100 rows (bench 25 avril),
  // 1000 rows ≈ 4.27MB — within limit. Reduce if descriptions grow significantly.
  const BATCH_SIZE = 1000;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE), "write");
  }
}

export async function getProduct(sku: string): Promise<ProductRow | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM products WHERE sku = ?`, args: [sku] });
  return result.rows.length > 0 ? rowToProduct(result.rows[0]) : null;
}

/** Imported catalog rows (shopify_product_id set), trimmed to what the intraday stock-check
 * needs: sku, baseline qty, Shopify product id, and last_seen_at. */
export interface StockBaselineRow {
  sku: string;
  qty: number;
  shopifyProductId: string;
  lastSeenAt: number;
}

export async function getStockBaseline(): Promise<StockBaselineRow[]> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT sku, qty, shopify_product_id, last_seen_at FROM products WHERE shopify_product_id IS NOT NULL`
  );
  return result.rows.map((row) => {
    const o = rowToObj(row);
    return {
      sku: (o.sku as string) || "",
      qty: Number(o.qty) || 0,
      shopifyProductId: String(o.shopify_product_id),
      lastSeenAt: Number(o.last_seen_at) || 0,
    };
  });
}

/** Write back the new baseline qty (and bump last_seen_at) for the SKUs the stock-check
 * acted on, so the next run diffs from the current state. Batched; no-op on empty input. */
export async function updateStockBaselineQty(updates: Array<{ sku: string; qty: number }>): Promise<void> {
  if (updates.length === 0) return;
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const stmts = updates.map((u) => ({
    sql: `UPDATE products SET qty = ?, last_seen_at = ? WHERE sku = ?`,
    args: [u.qty, now, u.sku],
  }));
  const BATCH_SIZE = 1000;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE), "write");
  }
}

export interface ProductSnapshot {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  size: string;
  product_type: string;
  image1: string;
  image2: string;
  image3: string;
  image4: string;
  image5: string;
  image6: string;
  image7: string;
  video: string;
  description: string;
  short_description: string;
  material: string;
  gtin: string;
  weight: number;
  out_of_stock_expected: string;
  estimated_arrival: string;
  shopify_product_id: string | null;
}

const SNAPSHOT_COLS =
  "sku, name, price, qty, color, size, product_type, " +
  "image1, image2, image3, image4, image5, image6, image7, " +
  "video, description, short_description, material, gtin, weight, " +
  "out_of_stock_expected, estimated_arrival, shopify_product_id";

export async function getProductsSnapshot(): Promise<Map<string, ProductSnapshot>> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT ${SNAPSHOT_COLS} FROM products`);
  const map = new Map<string, ProductSnapshot>();
  for (const row of result.rows) {
    const o = rowToObj(row);
    const snap: ProductSnapshot = {
      sku: (o.sku as string) || "",
      name: (o.name as string) || "",
      price: Number(o.price) || 0,
      qty: Number(o.qty) || 0,
      color: (o.color as string) || "",
      size: (o.size as string) || "",
      product_type: (o.product_type as string) || "",
      image1: (o.image1 as string) || "",
      image2: (o.image2 as string) || "",
      image3: (o.image3 as string) || "",
      image4: (o.image4 as string) || "",
      image5: (o.image5 as string) || "",
      image6: (o.image6 as string) || "",
      image7: (o.image7 as string) || "",
      video: (o.video as string) || "",
      description: (o.description as string) || "",
      short_description: (o.short_description as string) || "",
      material: (o.material as string) || "",
      gtin: (o.gtin as string) || "",
      weight: Number(o.weight) || 0,
      out_of_stock_expected: (o.out_of_stock_expected as string) || "",
      estimated_arrival: (o.estimated_arrival as string) || "",
      shopify_product_id: (o.shopify_product_id as string | null) ?? null,
    };
    map.set(snap.sku, snap);
  }
  return map;
}

// ─── Product Type Counts (pre-computed table, rebuilt during sync) ──

async function getCachedProductTypes(db: ReturnType<typeof getDb>): Promise<{ type: string; count: number }[]> {
  const result = await db.execute(`SELECT type, count FROM product_type_counts ORDER BY type`);
  if (result.rows.length > 0) {
    return result.rows.map(row => {
      const o = rowToObj(row);
      return { type: o.type as string, count: Number(o.count) || 0 };
    });
  }
  // Fallback: compute and persist if table is empty (first run after migration)
  await rebuildProductTypeCounts();
  const fallback = await db.execute(`SELECT type, count FROM product_type_counts ORDER BY type`);
  return fallback.rows.map(row => {
    const o = rowToObj(row);
    return { type: o.type as string, count: Number(o.count) || 0 };
  });
}

/** Rebuild the product_type_counts table. Called after sync upserts products. */
export async function rebuildProductTypeCounts(): Promise<void> {
  const db = await ensureSchema();
  const typeResult = await db.execute(
    `SELECT product_type, COUNT(*) as cnt FROM products WHERE product_type != '' GROUP BY product_type ORDER BY product_type`
  );
  const typeCounts = new Map<string, number>();
  for (const row of typeResult.rows) {
    const o = rowToObj(row);
    const pt = (o.product_type as string) || "";
    const cnt = Number(o.cnt) || 0;
    const parts = pt.split(">").map((s: string) => s.trim());
    let p = "";
    for (const part of parts) {
      p = p ? `${p} > ${part}` : part;
      typeCounts.set(p, (typeCounts.get(p) || 0) + cnt);
    }
  }
  // Rebuild table — one batch instead of N sequential execute() calls (~77s → ~2 queries)
  const inserts = [...typeCounts].map(([type, count]) => ({
    sql: `INSERT INTO product_type_counts (type, count) VALUES (?, ?)`,
    args: [type, count] as [string, number],
  }));
  await db.batch([{ sql: `DELETE FROM product_type_counts`, args: [] }, ...inserts], "write");
}

export async function getProducts(filters: {
  productType?: string;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  color?: string;
  size?: string;
  notImported?: boolean;
  withDiscount?: boolean;
  lowStock?: boolean;
  page?: number;
  limit?: number;
  sort?: string;
}): Promise<{ products: ProductRow[]; total: number; productTypes: { type: string; count: number }[] }> {
  const db = await ensureSchema();
  // WHERE clause + args are shared with getCatalogStats via buildCatalogWhere.
  const { where, args } = buildCatalogWhere(filters);
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(Math.max(1, filters.limit || 50), 200);
  const offset = (page - 1) * limit;

  let orderBy = "name ASC";
  let joinSort: "best_sellers" | "price_drop" | null = null;
  switch (filters.sort) {
    case "price_asc": orderBy = "price ASC"; break;
    case "price_desc": orderBy = "price DESC"; break;
    case "qty_asc": orderBy = "qty ASC"; break;
    case "qty_desc": orderBy = "qty DESC"; break;
    case "name_asc": orderBy = "name ASC"; break;
    case "name_desc": orderBy = "name DESC"; break;
    case "low_stock": orderBy = "CASE WHEN qty > 0 THEN 0 ELSE 1 END, qty ASC"; break;
    case "best_sellers": joinSort = "best_sellers"; break;
    case "price_drop": joinSort = "price_drop"; break;
  }

  // Select only columns the catalog UI needs
  const catalogColumns = "sku, name, price, qty, color, product_type, image1, shopify_product_id, shopify_handle";

  // `last_price` exposes the old_price of each SKU's most recent price change so the catalog
  // table can render the ▼/▲ movement badge (current price vs. previous price). ROW_NUMBER
  // picks exactly one row per SKU, ordered detected_at DESC then id DESC — the id tiebreak
  // makes selection deterministic when a SKU has two price changes in the same detected_at
  // second (detected_at is second-granularity, so batch syncs can collide). Restocks/
  // stock-only events are excluded (change_type filter), so the badge always reflects the
  // last *price* move, not an incidental stock update.
  const lastPriceCte = `last_price AS (
        SELECT sku, prev_price FROM (
          SELECT sku, old_price AS prev_price,
            ROW_NUMBER() OVER (PARTITION BY sku ORDER BY detected_at DESC, id DESC) AS rn
          FROM price_history
          WHERE change_type IN ('price_drop', 'price_increase') AND old_price IS NOT NULL
        ) WHERE rn = 1
      )`;

  // All three branches share the same shape: a `filtered` CTE applies the WHERE clause, the
  // result is LEFT JOINed to `last_price` (and, for the velocity/discount sorts, to a 14-day
  // `ph_agg`). COALESCE(…, 0) keeps products without history at the bottom of the list.
  const cutoff14d = Math.floor(Date.now() / 1000) - 14 * 86400;
  const filteredCte = `filtered AS (SELECT ${catalogColumns} FROM products ${where})`;
  const selectCols = `f.sku, f.name, f.price, f.qty, f.color, f.product_type, f.image1, f.shopify_product_id, f.shopify_handle, lp.prev_price`;
  let productsSql: string;
  let productsArgs: (string | number)[];

  if (joinSort === "best_sellers") {
    productsSql = `
      WITH ${filteredCte}, ${lastPriceCte},
      ph_agg AS (
        SELECT sku, SUM(old_qty - new_qty) AS units_moved
        FROM price_history WHERE detected_at > ? AND change_type = 'stock_change' AND old_qty > new_qty GROUP BY sku
      )
      SELECT ${selectCols}
      FROM filtered f
      LEFT JOIN last_price lp ON lp.sku = f.sku
      LEFT JOIN ph_agg ON ph_agg.sku = f.sku
      ORDER BY COALESCE(ph_agg.units_moved, 0) DESC LIMIT ? OFFSET ?`;
    productsArgs = [...args, cutoff14d, limit, offset];
  } else if (joinSort === "price_drop") {
    productsSql = `
      WITH ${filteredCte}, ${lastPriceCte},
      ph_agg AS (
        SELECT ph.sku,
          ROUND(((MAX(ph.old_price) - MIN(p2.price)) / MAX(ph.old_price)) * 100.0, 1) AS drop_pct
        FROM price_history ph JOIN products p2 ON p2.sku = ph.sku
        WHERE ph.detected_at > ? AND ph.change_type = 'price_drop' AND ph.old_price > p2.price AND ph.old_price > 0
        GROUP BY ph.sku
      )
      SELECT ${selectCols}
      FROM filtered f
      LEFT JOIN last_price lp ON lp.sku = f.sku
      LEFT JOIN ph_agg ON ph_agg.sku = f.sku
      ORDER BY COALESCE(ph_agg.drop_pct, 0) DESC LIMIT ? OFFSET ?`;
    productsArgs = [...args, cutoff14d, limit, offset];
  } else {
    productsSql = `
      WITH ${filteredCte}, ${lastPriceCte}
      SELECT ${selectCols}
      FROM filtered f
      LEFT JOIN last_price lp ON lp.sku = f.sku
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    productsArgs = [...args, limit, offset];
  }

  // Run count + data in parallel (2 round trips instead of 3)
  const [countResult, productsResult] = await Promise.all([
    db.execute({ sql: `SELECT COUNT(*) as cnt FROM products ${where}`, args }),
    db.execute({ sql: productsSql, args: productsArgs }),
  ]);

  const total = Number(rowToObj(countResult.rows[0]).cnt) || 0;
  const products = productsResult.rows.map(rowToProduct);

  // Product types: use cached value (refreshed on sync, not on every page load)
  const productTypes = await getCachedProductTypes(db);

  return { products, total, productTypes };
}

export interface CatalogStats {
  /** Total products in the catalog. */
  total: number;
  /** How many are imported into Shopify (shopify_product_id set). */
  imported: number;
  /** How many have an active rabais (last price > current price). */
  withDiscount: number;
  /** Most recent sync cron run (sync / sync-refresh / sync-shopify / sync-finalize). */
  lastSync: { name: string; status: string; ranAt: number } | null;
}

/**
 * Header metrics for the catalog page. Each count is a single COUNT(*); the last
 * sync is the newest cron_runs row whose name starts with "sync".
 */
export async function getCatalogStats(): Promise<CatalogStats> {
  const db = await ensureSchema();
  const [totalR, importedR, discountR, syncR] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS c FROM products`),
    db.execute(`SELECT COUNT(*) AS c FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`),
    // Precomputed flag (recomputeHasDiscount, refreshed each sync) — a cheap indexed scan
    // instead of the correlated EXISTS over price_history this used to run per page load.
    db.execute(`SELECT COUNT(*) AS c FROM products WHERE has_discount = 1`),
    // Bare name/status come from the MAX(ran_at) row (SQLite single-MAX rule).
    db.execute(`SELECT name, status, MAX(ran_at) AS ran_at FROM cron_runs WHERE name LIKE 'sync%'`),
  ]);

  const syncRow = syncR.rows.length > 0 ? rowToObj(syncR.rows[0]) : null;
  const lastSync =
    syncRow && syncRow.ran_at != null
      ? { name: syncRow.name as string, status: syncRow.status as string, ranAt: Number(syncRow.ran_at) || 0 }
      : null;

  return {
    total: Number(rowToObj(totalR.rows[0]).c) || 0,
    imported: Number(rowToObj(importedR.rows[0]).c) || 0,
    withDiscount: Number(rowToObj(discountR.rows[0]).c) || 0,
    lastSync,
  };
}

// ─── Collection Mappings ────────────────────────────────────────────

export type CollectionRole = "main" | "sub";

export interface CollectionMapping {
  aosomCategory: string;
  collectionRole?: CollectionRole; // optional for back-compat; defaults to 'sub' on upsert
  shopifyCollectionId: string;
  shopifyCollectionTitle: string;
}

function rowToMapping(row: Row): CollectionMapping {
  const o = rowToObj(row);
  return {
    aosomCategory: o.aosom_category as string,
    collectionRole: (o.collection_role as CollectionRole) || "sub",
    shopifyCollectionId: o.shopify_collection_id as string,
    shopifyCollectionTitle: o.shopify_collection_title as string,
  };
}

export async function getAllCollectionMappings(): Promise<CollectionMapping[]> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT aosom_category, collection_role, shopify_collection_id, shopify_collection_title FROM collection_mappings ORDER BY aosom_category, collection_role`,
  );
  return result.rows.map(rowToMapping);
}

/**
 * Infer collection_role from the aosom_category key when the caller doesn't specify one.
 * Level-1 keys (no " > ") represent top-level Aosom categories → main. Level-2+ keys
 * (contain " > ") represent subcategories → sub. This matches the migration seeding
 * logic and keeps the legacy /collections UI (which POSTs without a role field) from
 * polluting the table with bogus sub rows for level-1 keys.
 */
function inferRole(aosomCategory: string, explicit?: CollectionRole): CollectionRole {
  if (explicit) return explicit;
  return aosomCategory.includes(" > ") ? "sub" : "main";
}

export async function upsertCollectionMapping(mapping: CollectionMapping): Promise<void> {
  const db = await ensureSchema();
  const role = inferRole(mapping.aosomCategory, mapping.collectionRole);
  await db.execute({
    sql: `INSERT OR REPLACE INTO collection_mappings (aosom_category, collection_role, shopify_collection_id, shopify_collection_title, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))`,
    args: [mapping.aosomCategory, role, mapping.shopifyCollectionId, mapping.shopifyCollectionTitle],
  });
}

export async function upsertCollectionMappingsBatch(mappings: CollectionMapping[]): Promise<void> {
  const db = await ensureSchema();
  await db.batch(
    mappings.map((m) => ({
      sql: `INSERT OR REPLACE INTO collection_mappings (aosom_category, collection_role, shopify_collection_id, shopify_collection_title, updated_at) VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      args: [m.aosomCategory, inferRole(m.aosomCategory, m.collectionRole), m.shopifyCollectionId, m.shopifyCollectionTitle],
    })),
    "write",
  );
}

export async function deleteCollectionMapping(aosomCategory: string, role?: CollectionRole): Promise<void> {
  const db = await ensureSchema();
  if (role) {
    await db.execute({
      sql: `DELETE FROM collection_mappings WHERE aosom_category = ? AND collection_role = ?`,
      args: [aosomCategory, role],
    });
  } else {
    await db.execute({ sql: `DELETE FROM collection_mappings WHERE aosom_category = ?`, args: [aosomCategory] });
  }
}

/**
 * Look up BOTH the main and sub collections for a product.
 *
 * Lookup order for each role:
 *   1. Exact match on the full productType
 *   2. Walk up the hierarchy (strip trailing " > X" segments) and retry
 *
 * Returns an object with `main` and `sub` fields, each null if no match found.
 */
export async function findCollectionsForProduct(
  productType: string,
): Promise<{ main: CollectionMapping | null; sub: CollectionMapping | null }> {
  const db = await ensureSchema();
  const parts = productType.split(">").map((s) => s.trim()).filter(Boolean);

  async function lookup(role: CollectionRole): Promise<CollectionMapping | null> {
    // Walk from most specific to least specific
    for (let i = parts.length; i >= 1; i--) {
      const category = parts.slice(0, i).join(" > ");
      const result = await db.execute({
        sql: `SELECT * FROM collection_mappings WHERE aosom_category = ? AND collection_role = ?`,
        args: [category, role],
      });
      if (result.rows.length > 0) return rowToMapping(result.rows[0]);
    }
    return null;
  }

  const [main, sub] = await Promise.all([lookup("main"), lookup("sub")]);
  return { main, sub };
}

export async function getProductsWithShopifyId(): Promise<{ sku: string; product_type: string; shopify_product_id: string }[]> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT sku, product_type, shopify_product_id FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`);
  return result.rows.map(row => {
    const o = rowToObj(row);
    return { sku: o.sku as string, product_type: o.product_type as string, shopify_product_id: o.shopify_product_id as string };
  });
}

export async function getProductCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as cnt FROM products`);
  return Number(rowToObj(result.rows[0]).cnt) || 0;
}

export async function getImportedProductCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as cnt FROM products WHERE shopify_product_id IS NOT NULL`);
  return Number(rowToObj(result.rows[0]).cnt) || 0;
}

export async function updateProductShopifyIds(sku: string, shopifyProductId: string, shopifyVariantId: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE products SET shopify_product_id = ?, shopify_variant_id = ? WHERE sku = ?`, args: [shopifyProductId, shopifyVariantId, sku] });
}

/**
 * Persist the Shopify product id + storefront handle onto every catalog row (one per
 * variant SKU) of a freshly-imported product, so the dashboard can deep-link to the
 * storefront `/products/{handle}`. Called from the import pipeline after createShopifyProduct.
 */
export async function linkProductToShopify(skus: string[], shopifyProductId: string, handle: string | null): Promise<void> {
  const unique = [...new Set(skus.filter((s) => typeof s === "string" && s.length > 0))];
  if (unique.length === 0) return;
  const db = await ensureSchema();
  await db.batch(
    unique.map((sku) => ({
      sql: `UPDATE products SET shopify_product_id = ?, shopify_handle = ? WHERE sku = ?`,
      args: [shopifyProductId, handle, sku],
    })),
    "write",
  );
}

// ─── Price History (enriched) ────────────────────────────────────────

export type ChangeTypeHistory = "price_drop" | "price_increase" | "stock_change" | "new_product" | "restock" | "floor_correction";

export async function recordPriceChange(entry: {
  sku: string; oldPrice: number | null; newPrice: number | null;
  oldQty: number | null; newQty: number | null; changeType: ChangeTypeHistory;
}): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type) VALUES (?, ?, ?, ?, ?, ?)`, args: [entry.sku, entry.oldPrice, entry.newPrice, entry.oldQty, entry.newQty, entry.changeType] });
}

export async function recordPriceChanges(entries: {
  sku: string; oldPrice: number | null; newPrice: number | null;
  oldQty: number | null; newQty: number | null; changeType: ChangeTypeHistory;
}[]): Promise<void> {
  const db = await ensureSchema();
  const stmts = entries.map((e) => ({
    sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [e.sku, e.oldPrice, e.newPrice, e.oldQty, e.newQty, e.changeType],
  }));
  // price_history rows are small (6 cols) — 100 is fine, not the sync bottleneck
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), "write");
  }
}

/**
 * Record a price-floor auto-correction (change_type='floor_correction'). `applied` is set to
 * 1 when the corrected price was successfully pushed to Shopify, 0 when the push failed (or no
 * variant was matched) — the latter keeps an audit trail of the unresolved violation.
 */
export async function recordFloorCorrection(entry: {
  sku: string; oldPrice: number; newPrice: number; applied: boolean;
}): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO price_history (sku, old_price, new_price, old_qty, new_qty, change_type, applied_to_shopify) VALUES (?, ?, ?, NULL, NULL, 'floor_correction', ?)`,
    args: [entry.sku, entry.oldPrice, entry.newPrice, entry.applied ? 1 : 0],
  });
}

export async function markPriceChangeApplied(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE price_history SET applied_to_shopify = 1 WHERE id = ?`, args: [id] });
}

/**
 * Mark the price_history row matching a just-pushed price as applied to Shopify
 * (`applied_to_shopify = 1`). Called after a successful `updateShopifyVariantPrice`
 * in `applyToShopify` (shared by the manual sync and Phase 2 `runShopifyPush`).
 *
 * The push path works from diffs, not price_history ids, so we resolve the row by
 * **SKU + the pushed price** (`new_price ≈ newPrice`): the newest un-applied
 * price-change row whose recorded new price equals what we just pushed. Matching on
 * `new_price` (not just SKU) is what keeps this correct when Phase 2 pushes without a
 * fresh `recordPriceChanges`, and when a floor-correction has no recorded row at all
 * (then there's simply no match → no-op). Returns rows updated (0 or 1).
 */
export async function markPriceChangeAppliedBySku(sku: string, newPrice: number): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE price_history SET applied_to_shopify = 1
          WHERE id = (
            SELECT MAX(id) FROM price_history
            WHERE sku = ? AND change_type IN ('price_drop', 'price_increase')
              AND applied_to_shopify = 0 AND ABS(new_price - ?) < 0.01
          )`,
    args: [sku, newPrice],
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Delete price_history rows older than `days` (default 90). price_history grows
 * unbounded — every sync inserts price/stock change rows — which inflates both
 * Turso storage AND the row-reads of the correlated "Avec rabais" discount query
 * (catalog-filters PRODUCT_HAS_DISCOUNT_SQL).
 *
 * IMPORTANT: the discount badge / "Avec rabais" count read each SKU's *most recent*
 * price-change row (price_drop/price_increase). A product whose last price move was
 * >90 days ago is still on sale, so we must NOT purge that row or the product would
 * silently drop its badge. We therefore keep the latest price-change row per SKU and
 * only purge everything else older than the window (old stock_change rows + superseded
 * price-change rows). Called once/day at the end of the sync. Returns rows deleted.
 */
export async function purgeOldPriceHistory(days = 90): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `DELETE FROM price_history
          WHERE detected_at < unixepoch('now', ?)
            AND id NOT IN (
              SELECT MAX(id) FROM price_history
              WHERE change_type IN ('price_drop', 'price_increase')
              GROUP BY sku
            )`,
    args: [`-${days} days`],
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Delete sync_logs rows older than `days` (default 7). sync_logs records one row per
 * changed field per sync, so it grows fast (~10k rows after a few weeks) and inflates
 * Turso storage / row-reads. The history UI (`getSyncLogs`) only ever reads logs for a
 * specific recent `sync_run_id`, so a 7-day window keeps every run a user can still drill
 * into while dropping the long tail. Called once/day at the end of the sync.
 *
 * NOTE: sync_logs has no `created_at` epoch column — its timestamp is an ISO-8601 TEXT
 * string (`new Date().toISOString()`, e.g. `2026-06-14T16:25:39.612Z`). We parse it with
 * `unixepoch(timestamp)` so the comparison is numeric (correct across the boundary day,
 * unlike a lexical compare of ISO `T`/`Z` text against `datetime('now',…)`). A malformed/
 * NULL timestamp yields NULL and is left in place — safe, never over-deletes. Returns rows
 * deleted.
 */
export async function purgeOldSyncLogs(days = 7): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `DELETE FROM sync_logs WHERE unixepoch(timestamp) < unixepoch('now', ?)`,
    args: [`-${days} days`],
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Delete notifications older than `days` (default 30). Notifications are transient
 * dashboard alerts regenerated by each sync, so a 30-day window is ample. `created_at`
 * is a unix-seconds INTEGER, compared directly against `unixepoch('now', …)`. Purges
 * read and unread alike — a 30-day-old unseen alert is stale. Called once/day at the end
 * of the sync. Returns rows deleted.
 */
export async function purgeOldNotifications(days = 30): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `DELETE FROM notifications WHERE created_at < unixepoch('now', ?)`,
    args: [`-${days} days`],
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Delete cron_runs rows older than `days` (default 30). One row is written per cron
 * invocation (the publisher runs hourly), so the table grows fast; the dashboard
 * only reads the latest run per cron name. `ran_at` is a unix-seconds INTEGER. Called
 * once/day at the end of the sync. Returns rows deleted.
 */
export async function purgeOldCronRuns(days = 30): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `DELETE FROM cron_runs WHERE ran_at < unixepoch('now', ?)`,
    args: [`-${days} days`],
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Delete feed_syncs rows older than `days` (default 30). One row per feed fetch; the
 * dashboard only reads the latest success/attempt per feed_type. `fetched_at` is a
 * unix-seconds INTEGER. Called once/day at the end of the sync. Returns rows deleted.
 */
export async function purgeOldFeedSyncs(days = 30): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `DELETE FROM feed_syncs WHERE fetched_at < unixepoch('now', ?)`,
    args: [`-${days} days`],
  });
  return Number(result.rowsAffected) || 0;
}

/**
 * Recompute products.has_discount for every product using the canonical
 * PRODUCT_HAS_DISCOUNT_SQL predicate (single source of truth, also used by the
 * ▼ badge logic). Runs once/day at sync finalize instead of evaluating the
 * correlated EXISTS on every catalog/dashboard page load. getCatalogStats and the
 * "Avec rabais" filter then read the precomputed, partial-indexed flag — a cheap scan.
 * products.price + price_history only change during the daily sync, so the flag stays
 * accurate between syncs.
 */
export async function recomputeHasDiscount(): Promise<void> {
  const db = await ensureSchema();
  await db.execute(`UPDATE products SET has_discount = CASE WHEN ${PRODUCT_HAS_DISCOUNT_SQL} THEN 1 ELSE 0 END`);
}

export async function getRecentPriceChanges(limit = 50): Promise<Record<string, unknown>[]> {
  const db = await ensureSchema();
  // Exclude 'floor_correction' rows: they are audit auto-corrections (surfaced on the
  // dedicated dashboard floor card), not feed-driven price changes. Including them would let a
  // batch of corrections crowd real price_drop/price_increase events out of this limited window.
  const result = await db.execute({
    sql: `SELECT ph.*, p.name, p.image1, p.shopify_product_id, p.shopify_handle
    FROM price_history ph LEFT JOIN products p ON ph.sku = p.sku
    WHERE ph.change_type != 'floor_correction'
    ORDER BY ph.detected_at DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map(rowToObj);
}

// ─── Notifications ──────────────────────────────────────────────────

export async function createNotification(type: string, title: string, message: string): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `INSERT INTO notifications (type, title, message) VALUES (?, ?, ?)`, args: [type, title, message] });
  return Number(result.lastInsertRowid);
}

export async function getNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  const db = await ensureSchema();
  const where = opts.unreadOnly ? "WHERE read = 0" : "";
  const limit = opts.limit || 50;
  const result = await db.execute({ sql: `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`, args: [limit] });
  return result.rows.map(rowToObj);
}

export async function markNotificationRead(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE notifications SET read = 1 WHERE id = ?`, args: [id] });
}

// ─── Price alerts ("notify me when the price drops") ────────────────────

export interface TriggeredPriceAlert {
  id: number;
  email: string;
  sku: string;
  priceAtSignup: number;
  currentPrice: number;
  productName: string | null;
  shopifyHandle: string | null;
}

/**
 * Upsert a price-drop alert (double opt-in). A signup always starts unconfirmed
 * (confirmed=0) with a fresh confirm token; re-signing up for the same
 * (email, sku) also resets the reference price, clears notified_at, and issues a
 * new token — so the visitor must (re-)confirm before any alert is sent.
 */
export async function upsertPriceAlert(alert: {
  email: string;
  sku: string;
  shopifyProductId?: string | null;
  priceAtSignup: number;
  confirmToken: string;
  tokenExpiresAt: number;
}): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO price_alerts (email, sku, shopify_product_id, price_at_signup, created_at, notified_at, confirmed, confirm_token, token_expires_at)
          VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)
          ON CONFLICT(email, sku) DO UPDATE SET
            price_at_signup = excluded.price_at_signup,
            shopify_product_id = excluded.shopify_product_id,
            created_at = excluded.created_at,
            notified_at = NULL,
            confirmed = 0,
            confirm_token = excluded.confirm_token,
            token_expires_at = excluded.token_expires_at`,
    args: [alert.email, alert.sku, alert.shopifyProductId ?? null, alert.priceAtSignup, now, alert.confirmToken, alert.tokenExpiresAt],
  });
}

/**
 * Confirm an alert by its token (double opt-in). Matches a non-expired,
 * still-unconfirmed token; sets confirmed=1 and clears the token (single use).
 * Returns the confirmed row + product handle for the success redirect, or null
 * when the token is unknown/expired/already used.
 */
export async function confirmPriceAlert(
  token: string,
): Promise<{ sku: string; shopifyHandle: string | null } | null> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const found = await db.execute({
    sql: `SELECT a.id, a.sku, p.shopify_handle AS shopify_handle
          FROM price_alerts a LEFT JOIN products p ON p.sku = a.sku
          WHERE a.confirm_token = ? AND a.confirmed = 0 AND a.token_expires_at > ?`,
    args: [token, now],
  });
  if (found.rows.length === 0) return null;
  const row = found.rows[0];
  await db.execute({
    sql: `UPDATE price_alerts SET confirmed = 1, confirm_token = NULL, token_expires_at = NULL WHERE id = ?`,
    args: [Number(row.id)],
  });
  return { sku: String(row.sku), shopifyHandle: (row.shopify_handle as string) || null };
}

/**
 * Pending alerts whose product's current price has dropped below the signup
 * price. Joins products for the live price + name + handle; alerts for SKUs no
 * longer in the catalog are naturally excluded by the inner join.
 */
export async function getTriggeredPriceAlerts(): Promise<TriggeredPriceAlert[]> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT a.id, a.email, a.sku, a.price_at_signup,
            p.price AS current_price, p.name AS product_name, p.shopify_handle AS shopify_handle
     FROM price_alerts a
     JOIN products p ON p.sku = a.sku
     WHERE a.notified_at IS NULL AND a.confirmed = 1 AND p.price < a.price_at_signup`,
  );
  return result.rows.map((r) => ({
    id: Number(r.id),
    email: String(r.email),
    sku: String(r.sku),
    priceAtSignup: Number(r.price_at_signup),
    currentPrice: Number(r.current_price),
    productName: (r.product_name as string) || null,
    shopifyHandle: (r.shopify_handle as string) || null,
  }));
}

/** Stamp notified_at on the given alert ids so they aren't re-notified. */
export async function markPriceAlertsNotified(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const placeholders = ids.map(() => "?").join(",");
  await db.execute({
    sql: `UPDATE price_alerts SET notified_at = ? WHERE id IN (${placeholders})`,
    args: [now, ...ids],
  });
}

// ─── Back-in-stock waitlist ─────────────────────────────────────────
/**
 * Record a "notify me when back in stock" signup. Idempotent per (email, sku):
 * a repeat signup refreshes the row and re-arms it (notified_at → NULL, confirmed
 * → 0, new token) so a customer can re-confirm and be alerted again after the item
 * goes out of stock and returns. Stored unconfirmed (double opt-in, CASL).
 */
export async function upsertWaitlistEntry(entry: {
  email: string;
  sku: string;
  shopifyProductId?: string | null;
  confirmToken: string;
  tokenExpiresAt: number;
}): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({
    sql: `INSERT INTO back_in_stock_waitlist (email, sku, shopify_product_id, created_at, notified_at, confirmed, confirm_token, token_expires_at)
          VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
          ON CONFLICT(email, sku) DO UPDATE SET
            shopify_product_id = excluded.shopify_product_id,
            created_at = excluded.created_at,
            notified_at = NULL,
            confirmed = 0,
            confirm_token = excluded.confirm_token,
            token_expires_at = excluded.token_expires_at`,
    args: [entry.email, entry.sku, entry.shopifyProductId ?? null, now, entry.confirmToken, entry.tokenExpiresAt],
  });
}

/**
 * Confirm a waitlist signup by its token (double opt-in). Matches a non-expired,
 * still-unconfirmed token; sets confirmed=1 and clears the token (single use).
 * Returns the sku + product handle for the success redirect, or null when the
 * token is unknown/expired/already used.
 */
export async function confirmWaitlist(
  token: string,
): Promise<{ sku: string; shopifyHandle: string | null } | null> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const found = await db.execute({
    sql: `SELECT w.id, w.sku, p.shopify_handle AS shopify_handle
          FROM back_in_stock_waitlist w LEFT JOIN products p ON p.sku = w.sku
          WHERE w.confirm_token = ? AND w.confirmed = 0 AND w.token_expires_at > ?`,
    args: [token, now],
  });
  if (found.rows.length === 0) return null;
  const row = found.rows[0];
  await db.execute({
    sql: `UPDATE back_in_stock_waitlist SET confirmed = 1, confirm_token = NULL, token_expires_at = NULL WHERE id = ?`,
    args: [Number(row.id)],
  });
  return { sku: String(row.sku), shopifyHandle: (row.shopify_handle as string) || null };
}

/** Pending (confirmed + un-notified) waitlist subscribers for a SKU. */
export async function getPendingWaitlist(sku: string): Promise<{ id: number; email: string }[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT id, email FROM back_in_stock_waitlist WHERE sku = ? AND notified_at IS NULL AND confirmed = 1`,
    args: [sku],
  });
  return result.rows.map((r) => ({ id: Number(r.id), email: String(r.email) }));
}

/** Stamp notified_at on the given waitlist ids so they aren't re-notified. */
export async function markWaitlistNotified(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const placeholders = ids.map(() => "?").join(",");
  await db.execute({
    sql: `UPDATE back_in_stock_waitlist SET notified_at = ? WHERE id IN (${placeholders})`,
    args: [now, ...ids],
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  const db = await ensureSchema();
  await db.execute(`UPDATE notifications SET read = 1 WHERE read = 0`);
}

export async function getUnreadNotificationCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as count FROM notifications WHERE read = 0`);
  return Number(rowToObj(result.rows[0]).count) || 0;
}

// ─── Users ──────────────────────────────────────────────────────────

export type DbUserRole = UserRole;

export async function getUserByUsername(username: string): Promise<{ id: number; username: string; password_hash: string; role: DbUserRole } | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT id, username, password_hash, role FROM users WHERE username = ?`, args: [username] });
  if (result.rows.length === 0) return null;
  const o = rowToObj(result.rows[0]);
  const role = (o.role as string) === "reviewer" ? "reviewer" : "admin";
  return { id: Number(o.id), username: o.username as string, password_hash: o.password_hash as string, role };
}

export async function createUser(username: string, passwordHash: string, role: DbUserRole = "admin"): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, args: [username, passwordHash, role] });
  return Number(result.lastInsertRowid);
}

export async function getUserCount(): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT COUNT(*) as cnt FROM users`);
  return Number(rowToObj(result.rows[0]).cnt) || 0;
}

export async function updateUserLastLogin(id: number): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({ sql: `UPDATE users SET last_login_at = ? WHERE id = ?`, args: [now, id] });
}

export async function updateUserPassword(id: number, passwordHash: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE users SET password_hash = ? WHERE id = ?`, args: [passwordHash, id] });
}

// ─── Settings ────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT value FROM settings WHERE key = ?`, args: [key] });
  if (result.rows.length === 0) return null;
  return (rowToObj(result.rows[0]).value as string) ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await db.execute({ sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, args: [key, value, now] });
}

/**
 * Minimal sku→price projection for the price-floor audit (price-audit.ts). Only priced rows;
 * `price` is the Aosom feed price used as the floor. Kept tiny (2 cols, ~11k rows) so the audit
 * doesn't pull heavy catalog columns.
 */
export async function getProductsForPriceAudit(): Promise<{ sku: string; price: number }[]> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT sku, price FROM products WHERE price > 0` });
  return result.rows.map((r) => {
    const o = rowToObj(r);
    return { sku: o.sku as string, price: Number(o.price) || 0 };
  });
}

/**
 * Imported products that have gone stale in the Aosom feed: present on Shopify
 * (`shopify_product_id` not null), still showing stock (`qty > 0`), but not seen in the CSV
 * for `maxAgeDays` days. These are likely discontinued at Aosom yet still sellable on the
 * storefront (oversell risk). Consumed by the stale-catalog cron, which drafts them.
 */
export async function getStaleImportedProducts(maxAgeDays = 30): Promise<{ sku: string; shopify_product_id: string }[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT sku, shopify_product_id FROM products
          WHERE shopify_product_id IS NOT NULL AND qty > 0 AND last_seen_at < unixepoch() - 86400 * ?
          ORDER BY last_seen_at ASC`,
    args: [maxAgeDays],
  });
  return result.rows.map((r) => {
    const o = rowToObj(r);
    return { sku: o.sku as string, shopify_product_id: String(o.shopify_product_id) };
  });
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT key, value FROM settings`);
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    const o = rowToObj(row);
    settings[o.key as string] = o.value as string;
  }
  return settings;
}

// ─── Trending Products ──────────────────────────────────────────────

export interface TrendingProduct {
  sku: string; name: string; price: number; image1: string;
  shopify_product_id: string | null; shopify_handle: string | null; units_moved: number; current_qty: number;
}

export async function getTrendingProducts(limit = 10): Promise<TrendingProduct[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT ph.sku, p.name, p.price, p.image1, p.shopify_product_id, p.shopify_handle,
           p.qty AS current_qty,
           SUM(ph.old_qty - ph.new_qty) as units_moved
    FROM price_history ph JOIN products p ON ph.sku = p.sku
    WHERE ph.change_type = 'stock_change'
      AND ph.detected_at > cast(strftime('%s','now','-14 days') as integer)
      AND ph.old_qty > ph.new_qty
    GROUP BY ph.sku ORDER BY units_moved DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((row) => {
    const o = rowToObj(row);
    return {
      sku: (o.sku as string) || "",
      name: (o.name as string) || "",
      price: Number(o.price) || 0,
      image1: (o.image1 as string) || "",
      shopify_product_id: (o.shopify_product_id as string) || null,
      shopify_handle: (o.shopify_handle as string) || null,
      units_moved: Number(o.units_moved) || 0,
      current_qty: Number(o.current_qty) || 0,
    };
  });
}

// ─── Sync Runs ───────────────────────────────────────────────────────

export async function clearStaleLockIfNeeded(thresholdMinutes = 30): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE sync_runs SET status = 'failed', completed_at = datetime('now'),
      error_messages = ?
    WHERE status = 'running'
      AND (strftime('%s','now') - strftime('%s', started_at)) > ?`,
    args: [
      JSON.stringify([`Stale lock cleared (timeout > ${thresholdMinutes} min)`]),
      thresholdMinutes * 60,
    ],
  });
}

export async function createSyncRun(): Promise<SyncRun> {
  const db = await ensureSchema();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({ sql: `INSERT INTO sync_runs (id, started_at, status) VALUES (?, ?, 'running')`, args: [id, now] });
  return { id, startedAt: now, completedAt: null, status: "running", totalProducts: 0, created: 0, updated: 0, archived: 0, errors: 0, errorMessages: [] };
}

export async function completeSyncRun(
  id: string,
  stats: { status: "completed" | "failed"; totalProducts: number; created: number; updated: number; archived: number; errors: number; errorMessages: string[] }
): Promise<void> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `UPDATE sync_runs SET completed_at=?, status=?, total_products=?, created=?, updated=?, archived=?, errors=?, error_messages=? WHERE id=? AND status='running'`, args: [new Date().toISOString(), stats.status, stats.totalProducts, stats.created, stats.updated, stats.archived, stats.errors, JSON.stringify(stats.errorMessages), id] });
  if ((result.rowsAffected ?? 0) === 0) {
    console.warn("[DB] completeSyncRun: no running row for id", id, "(already completed or id unknown)");
  }
}

export async function updateSyncRunTiming(id: string, timing: Record<string, number>): Promise<void> {
  try {
    const db = await ensureSchema();
    await db.execute({ sql: `UPDATE sync_runs SET timing_ms = ? WHERE id = ?`, args: [JSON.stringify(timing), id] });
  } catch (err) {
    // non-fatal — timing writes must not interrupt or mask sync errors
    console.warn("[DB] updateSyncRunTiming failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

export async function getSyncRuns(limit = 20): Promise<SyncRun[]> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?`, args: [limit] });
  return result.rows.map((r) => mapSyncRun(rowToObj(r)));
}

export async function getLatestSyncRun(): Promise<SyncRun | null> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1`);
  return result.rows.length > 0 ? mapSyncRun(rowToObj(result.rows[0])) : null;
}

// ─── Dashboard: cron + feed run tracking ─────────────────────────────────────

/** Record one cron invocation. status is "success" | "error". Never throws on its own
 * (callers wrap the real work; a failed write here must not mask the cron's own result). */
export async function recordCronRun(name: string, status: "success" | "error", detail?: string): Promise<void> {
  try {
    const db = await ensureSchema();
    await db.execute({
      sql: `INSERT INTO cron_runs (name, status, detail, ran_at) VALUES (?, ?, ?, ?)`,
      args: [name, status, detail ?? null, Math.floor(Date.now() / 1000)],
    });
  } catch (err) {
    console.error(`[cron_runs] failed to record run for ${name}:`, err);
  }
}

/** Record one feed fetch. Best-effort (never throws). */
export async function recordFeedSync(feedType: string, itemCount: number | null, status: "success" | "error", error?: string): Promise<void> {
  try {
    const db = await ensureSchema();
    await db.execute({
      sql: `INSERT INTO feed_syncs (feed_type, item_count, status, error, fetched_at) VALUES (?, ?, ?, ?, ?)`,
      args: [feedType, itemCount, status, error ?? null, Math.floor(Date.now() / 1000)],
    });
  } catch (err) {
    console.error(`[feed_syncs] failed to record fetch for ${feedType}:`, err);
  }
}

export interface CronRunSummary { name: string; status: string; detail: string | null; ranAt: number; }
export interface FeedSyncSummary {
  feedType: string;
  /** Epoch of the last SUCCESSFUL fetch; null if it has never succeeded. */
  lastSuccessAt: number | null;
  /** Item count of that last successful fetch. */
  itemCount: number | null;
  /** Status of the most recent attempt (any status): "success" | "error" | null (never run). */
  lastStatus: string | null;
}
export interface ErroredImportJob { id: string; groupKey: string; sku: string | null; error: string | null; updatedAt: string; }

export interface DashboardSummary {
  newProductsToday: number;
  draftsThisWeek: number;
  activePriceAlerts: number;
  crons: CronRunSummary[];
}

// ─── Dashboard metrics cache (in-memory, per-process, TTL) ──────────────
// The dashboard panels re-fire their COUNT/aggregate queries on every load/poll.
// A 5-minute TTL cache cuts repeated Turso row-reads for warm serverless instances
// (cache is per-instance and resets on cold start — acceptable; these panels tolerate
// minutes of staleness). Gated to production (Turso): local SQLite has no read quota,
// and bypassing in tests avoids cross-test contamination from a shared module cache.
const _metricsCache = new Map<string, { data: unknown; expires: number }>();
const METRICS_TTL_MS = 5 * 60 * 1000;

async function cachedMetric<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (!process.env.TURSO_DATABASE_URL) return fn(); // no cache locally / in tests
  const hit = _metricsCache.get(key);
  if (hit && Date.now() < hit.expires) return hit.data as T;
  const data = await fn();
  _metricsCache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}

/** Clear the dashboard metrics cache. The cache is intentionally not auto-invalidated on
 * writes — the panels tolerate ≤5 min of staleness, so writers don't call this. Exposed for
 * tests and for any caller that explicitly wants the next dashboard read to recompute. */
export function clearMetricsCache(): void {
  _metricsCache.clear();
}

/** "Résumé du jour" DB metrics (Meta-Ads revenue is merged client-side from /api/ads/insights). */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  return cachedMetric("dashboard_summary", METRICS_TTL_MS, _loadDashboardSummary);
}

async function _loadDashboardSummary(): Promise<DashboardSummary> {
  const db = await ensureSchema();
  const now = new Date();
  const todayStart = startOfUtcDayEpoch(now);
  const weekAgo = epochDaysAgo(now, 7);
  const [newProd, drafts, alerts, crons] = await Promise.all([
    // "new_product" is logged in price_history when a SKU is first seen (canonical import signal).
    db.execute({ sql: `SELECT COUNT(*) AS c FROM price_history WHERE change_type = 'new_product' AND detected_at >= ?`, args: [todayStart] }),
    db.execute({ sql: `SELECT COUNT(*) AS c FROM facebook_drafts WHERE created_at >= ?`, args: [weekAgo] }),
    db.execute({ sql: `SELECT COUNT(*) AS c FROM price_alerts WHERE confirmed = 1` }),
    // Latest run per cron (single-MAX bare-column rule picks status/detail from the newest row).
    db.execute({ sql: `SELECT name, status, detail, MAX(ran_at) AS ran_at FROM cron_runs GROUP BY name ORDER BY name ASC` }),
  ]);
  return {
    newProductsToday: Number(rowToObj(newProd.rows[0]).c) || 0,
    draftsThisWeek: Number(rowToObj(drafts.rows[0]).c) || 0,
    activePriceAlerts: Number(rowToObj(alerts.rows[0]).c) || 0,
    crons: crons.rows.map((r) => {
      const o = rowToObj(r);
      return { name: o.name as string, status: o.status as string, detail: (o.detail as string) ?? null, ranAt: Number(o.ran_at) || 0 };
    }),
  };
}

export interface PriceFloorAlert {
  belowFloorCount: number;
  total: number;
  /** Below-floor variants auto-corrected on Shopify in the last audit. */
  corrected: number;
  /** Below-floor variants whose correction failed (need manual attention). */
  failed: number;
  /** Below-floor variants deferred past the per-run cap (corrected on a later run). */
  deferred: number;
  auditedAt: number | null; // epoch seconds of the last audit, null if never run
  topItems: {
    sku: string;
    shopify_price: number;
    aosom_price: number;
    gap: number;
    corrected_price?: number;
    status?: "corrected" | "failed";
    error?: string;
  }[];
}

export interface DashboardAlerts {
  erroredImportJobs: ErroredImportJob[];
  staleDraftCount: number;
  feeds: FeedSyncSummary[];
  /** Last price-floor audit summary (from settings.price_audit_result). null if never run. */
  priceFloor: PriceFloorAlert | null;
}

/** "Alertes" DB metrics (Meta token expiry is added by the route via debug_token). */
export async function getDashboardAlerts(): Promise<DashboardAlerts> {
  return cachedMetric("dashboard_alerts", METRICS_TTL_MS, _loadDashboardAlerts);
}

async function _loadDashboardAlerts(): Promise<DashboardAlerts> {
  const db = await ensureSchema();
  const weekAgo = epochDaysAgo(new Date(), 7);
  const [errs, stale, feeds, priceAudit] = await Promise.all([
    db.execute({ sql: `SELECT id, group_key, product_data, error, updated_at FROM import_jobs WHERE status = 'error' ORDER BY updated_at DESC LIMIT 20` }),
    db.execute({ sql: `SELECT COUNT(*) AS c FROM facebook_drafts WHERE status IN ('draft', 'pending') AND created_at < ?`, args: [weekAgo] }),
    // Per feed: time + count of the last SUCCESS, plus the status of the most recent
    // attempt (so a feed whose latest fetch errored is flagged even if an older success exists).
    db.execute({ sql: `SELECT f.feed_type AS feed_type,
        MAX(CASE WHEN f.status = 'success' THEN f.fetched_at END) AS last_success_at,
        (SELECT s.status FROM feed_syncs s WHERE s.feed_type = f.feed_type ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1) AS last_status,
        (SELECT s.item_count FROM feed_syncs s WHERE s.feed_type = f.feed_type AND s.status = 'success' ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1) AS item_count
      FROM feed_syncs f GROUP BY f.feed_type ORDER BY f.feed_type ASC` }),
    // Last price-floor audit summary (written by /api/health/price-audit). Cheap one-row read;
    // the expensive Shopify comparison runs in that endpoint, never on dashboard load.
    db.execute({ sql: `SELECT value FROM settings WHERE key = 'price_audit_result'` }),
  ]);
  const erroredImportJobs: ErroredImportJob[] = errs.rows.map((r) => {
    const o = rowToObj(r);
    let sku: string | null = null;
    try {
      const pd = JSON.parse((o.product_data as string) || "{}") as Record<string, unknown>;
      const variants = pd.variants as Array<{ sku?: string }> | undefined;
      sku = (pd.sku as string) || (pd.SKU as string) || (variants && variants[0]?.sku) || null;
    } catch { /* product_data not JSON — fall back to group_key */ }
    return { id: o.id as string, groupKey: o.group_key as string, sku, error: (o.error as string) ?? null, updatedAt: (o.updated_at as string) ?? "" };
  });
  let priceFloor: PriceFloorAlert | null = null;
  if (priceAudit.rows.length > 0) {
    try {
      const s = JSON.parse((rowToObj(priceAudit.rows[0]).value as string) || "{}") as Record<string, unknown>;
      priceFloor = {
        belowFloorCount: Number(s.belowFloor) || 0,
        total: Number(s.total) || 0,
        corrected: Number(s.corrected) || 0,
        failed: Number(s.failed) || 0,
        deferred: Number(s.deferred) || 0,
        auditedAt: s.auditedAt != null ? Number(s.auditedAt) : null,
        topItems: Array.isArray(s.topItems) ? (s.topItems as PriceFloorAlert["topItems"]) : [],
      };
    } catch { /* malformed setting — treat as no audit */ }
  }
  return {
    erroredImportJobs,
    staleDraftCount: Number(rowToObj(stale.rows[0]).c) || 0,
    feeds: feeds.rows.map((r) => {
      const o = rowToObj(r);
      return {
        feedType: o.feed_type as string,
        lastSuccessAt: o.last_success_at != null ? Number(o.last_success_at) : null,
        itemCount: o.item_count != null ? Number(o.item_count) : null,
        lastStatus: (o.last_status as string) ?? null,
      };
    }),
    priceFloor,
  };
}

function mapSyncRun(row: Record<string, unknown>): SyncRun {
  return {
    id: row.id as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) || null,
    status: row.status as SyncRun["status"],
    totalProducts: (row.total_products as number) || 0,
    created: (row.created as number) || 0,
    updated: (row.updated as number) || 0,
    archived: (row.archived as number) || 0,
    errors: (row.errors as number) || 0,
    errorMessages: JSON.parse((row.error_messages as string) || "[]"),
    timingMs: (() => { try { return row.timing_ms ? JSON.parse(row.timing_ms as string) : undefined; } catch { return undefined; } })(),
  };
}

// ─── Sync Logs ───────────────────────────────────────────────────────

export async function addSyncLogsBatch(entries: Omit<SyncLogEntry, "id">[]): Promise<void> {
  const db = await ensureSchema();
  const stmts = entries.map((e) => ({
    sql: `INSERT INTO sync_logs (id, sync_run_id, timestamp, shopify_product_id, sku, action, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), e.syncRunId, e.timestamp, e.shopifyProductId, e.sku, e.action, e.field, e.oldValue, e.newValue],
  }));
  // sync_logs rows are small (9 cols) — 100 is fine, not the sync bottleneck
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100), "write");
  }
}

export async function getSyncLogs(syncRunId: string, limit = 500): Promise<SyncLogEntry[]> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM sync_logs WHERE sync_run_id = ? ORDER BY timestamp DESC LIMIT ?`, args: [syncRunId, limit] });
  return result.rows.map((r) => mapSyncLog(rowToObj(r)));
}

function mapSyncLog(row: Record<string, unknown>): SyncLogEntry {
  return {
    id: row.id as string,
    syncRunId: row.sync_run_id as string,
    timestamp: row.timestamp as string,
    shopifyProductId: (row.shopify_product_id as string) || null,
    sku: row.sku as string,
    action: row.action as SyncLogEntry["action"],
    field: row.field as ChangeType,
    oldValue: (row.old_value as string) || null,
    newValue: (row.new_value as string) || null,
  };
}

// ─── Import Jobs ─────────────────────────────────────────────────────

const IMPORT_JOB_COLUMNS = new Set([
  "status", "content", "shopify_id", "error", "product_data", "group_key",
]);

export async function upsertImportJob(job: { id: string; groupKey: string; productData: string; status: string; createdAt: string; updatedAt: string }): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO import_jobs (id, group_key, product_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_key) DO UPDATE SET product_data=excluded.product_data, status='pending', updated_at=excluded.updated_at`,
    args: [job.id, job.groupKey, job.productData, job.status, job.createdAt, job.updatedAt],
  });
}

export async function getImportJobs(): Promise<Record<string, unknown>[]> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT * FROM import_jobs ORDER BY created_at DESC`);
  return result.rows.map(rowToObj);
}

export async function getImportJob(jobId: string): Promise<Record<string, unknown> | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM import_jobs WHERE id = ?`, args: [jobId] });
  return result.rows.length > 0 ? rowToObj(result.rows[0]) : null;
}

export async function updateImportJob(jobId: string, fields: Record<string, unknown>): Promise<void> {
  const db = await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!IMPORT_JOB_COLUMNS.has(key)) throw new Error(`Invalid column name: ${key}`);
    sets.push(`${key} = ?`);
    args.push(value as InValue);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?`);
  args.push(new Date().toISOString());
  args.push(jobId);
  await db.execute({ sql: `UPDATE import_jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

// ─── Video Jobs ──────────────────────────────────────────────────────

export type VideoEngine = "ffmpeg" | "kling" | "creatomate";
export type VideoContentType = "product" | "lifestyle" | "promo";
export type VideoLocale = "fr" | "en";
export type VideoStatus =
  | "pending"
  | "generating"
  | "ready"
  | "error"
  | "approved"
  | "rejected";

export interface VideoJob {
  id: number;
  engine: VideoEngine;
  content_type: VideoContentType;
  /** JSON-decoded array of SKUs (empty array when none were attached). */
  product_skus: string[];
  locale: VideoLocale;
  status: VideoStatus;
  video_url: string | null;
  video_path: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

function rowToVideoJob(row: Row): VideoJob {
  const o = rowToObj(row);
  let skus: string[] = [];
  try {
    const parsed = JSON.parse((o.product_skus as string) || "[]");
    if (Array.isArray(parsed)) skus = parsed.filter((s): s is string => typeof s === "string");
  } catch { /* product_skus not JSON — leave empty */ }
  return {
    id: Number(o.id),
    engine: o.engine as VideoEngine,
    content_type: o.content_type as VideoContentType,
    product_skus: skus,
    locale: o.locale as VideoLocale,
    status: o.status as VideoStatus,
    video_url: (o.video_url as string) ?? null,
    video_path: (o.video_path as string) ?? null,
    error_message: (o.error_message as string) ?? null,
    created_at: Number(o.created_at) || 0,
    updated_at: Number(o.updated_at) || 0,
  };
}

export async function createVideoJob(job: {
  engine: VideoEngine;
  contentType: VideoContentType;
  productSkus: string[];
  locale: VideoLocale;
}): Promise<VideoJob> {
  const db = await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute({
    sql: `INSERT INTO video_jobs (engine, content_type, product_skus, locale, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    args: [job.engine, job.contentType, JSON.stringify(job.productSkus), job.locale, now, now],
  });
  const created = await getVideoJob(Number(result.lastInsertRowid));
  if (!created) throw new Error("Failed to read back created video job");
  return created;
}

export async function getVideoJobs(opts: {
  status?: VideoStatus | VideoStatus[];
  page?: number;
  pageSize?: number;
} = {}): Promise<{ jobs: VideoJob[]; total: number }> {
  const db = await ensureSchema();
  const statuses = opts.status
    ? (Array.isArray(opts.status) ? opts.status : [opts.status])
    : [];
  const where = statuses.length > 0
    ? `WHERE status IN (${statuses.map(() => "?").join(", ")})`
    : "";
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize || 50));
  const offset = (page - 1) * pageSize;

  const [countResult, jobsResult] = await Promise.all([
    db.execute({ sql: `SELECT COUNT(*) AS c FROM video_jobs ${where}`, args: statuses }),
    db.execute({
      sql: `SELECT * FROM video_jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      args: [...statuses, pageSize, offset],
    }),
  ]);

  return {
    jobs: jobsResult.rows.map(rowToVideoJob),
    total: Number(rowToObj(countResult.rows[0]).c) || 0,
  };
}

export async function getVideoJob(id: number): Promise<VideoJob | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM video_jobs WHERE id = ?`, args: [id] });
  return result.rows.length > 0 ? rowToVideoJob(result.rows[0]) : null;
}

const VIDEO_JOB_COLUMNS = new Set([
  "engine", "content_type", "product_skus", "locale", "status",
  "video_url", "video_path", "error_message",
]);

export async function updateVideoJob(id: number, fields: Record<string, unknown>): Promise<void> {
  const db = await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!VIDEO_JOB_COLUMNS.has(key)) throw new Error(`Invalid column name: ${key}`);
    sets.push(`${key} = ?`);
    args.push(value as InValue);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = ?`);
  args.push(Math.floor(Date.now() / 1000));
  args.push(id);
  await db.execute({ sql: `UPDATE video_jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteVideoJob(id: number): Promise<boolean> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `DELETE FROM video_jobs WHERE id = ?`, args: [id] });
  return result.rowsAffected > 0;
}

// ─── Facebook Drafts ─────────────────────────────────────────────────

/** Per-channel publish state tracked inside facebook_drafts.channels (JSON). */
export interface ChannelState {
  status: "pending" | "published" | "error" | "skipped";
  publishedId?: string;
  publishedAt?: number;
  error?: string;
}

export interface FacebookDraft {
  id: number; sku: string; triggerType: string; language: string;
  postText: string;
  /** English caption for EN channels (Furnish Facebook, future Furnish IG). Optional for legacy drafts. */
  postTextEn: string | null;
  imagePath: string | null; imageUrl: string | null;
  /** Ordered public image URLs for multi-photo posts. Always ≥1 element when there is any image. */
  imageUrls: string[];
  /** Rendered Creatomate video URL (new_product drafts when Creatomate is configured). Publisher prefers it on Facebook. */
  videoUrl?: string | null;
  /** Vertical 9:16 Creatomate video URL for Instagram Reels. Publisher prefers it on Instagram. */
  reelsVideoUrl?: string | null;
  oldPrice: number | null; newPrice: number | null; status: string;
  scheduledAt: number | null; publishedAt: number | null;
  facebookPostId: string | null;
  /** Per-channel publish state. Keys are CHANNELS values (e.g. "fb_ameublo"). */
  channels: Record<string, ChannelState>;
  createdAt: number;
  /** FK to content_hooks — the hook that seeded this draft's caption. Null for legacy drafts. */
  hookId: number | null;
  approvedAt: number | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  /** Unsplash image + attribution. Populated for content_template drafts; null otherwise. */
  unsplashImageUrl: string | null;
  unsplashPhotographer: string | null;
  unsplashPhotographerUrl: string | null;
  productName?: string; productImage?: string;
}

// ─── Hook Pool DB functions (v0.1.20) ────────────────────────────────

export interface ContentTemplate {
  id: number;
  slug: string;
  content_type: "education" | "inspiration" | "engagement" | "seasonal";
  mode: "hook_seeded" | "generative_seeded";
  display_name_fr: string;
  display_name_en: string;
  prompt_pattern_fr: string;
  prompt_pattern_en: string;
  image_strategy: string;
  active: boolean;
  frequency_per_month: number;
  scopes: string[];
}

export async function getContentTemplates(options?: {
  content_type?: ContentTemplate["content_type"];
  active_only?: boolean;
}): Promise<ContentTemplate[]> {
  const db = await ensureSchema();
  let sql = `SELECT * FROM content_templates`;
  const args: InValue[] = [];
  const conditions: string[] = [];
  if (options?.active_only !== false) conditions.push(`active = 1`);
  if (options?.content_type) {
    conditions.push(`content_type = ?`);
    args.push(options.content_type);
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += ` ORDER BY id`;
  const result = await db.execute({ sql, args });
  return result.rows.map((r) => {
    const row = rowToObj(r);
    return {
      id: Number(row.id),
      slug: String(row.slug),
      content_type: row.content_type as ContentTemplate["content_type"],
      mode: (String(row.mode ?? "hook_seeded")) as ContentTemplate["mode"],
      display_name_fr: String(row.display_name_fr),
      display_name_en: String(row.display_name_en),
      prompt_pattern_fr: String(row.prompt_pattern_fr),
      prompt_pattern_en: String(row.prompt_pattern_en),
      image_strategy: String(row.image_strategy),
      active: Number(row.active) === 1,
      frequency_per_month: Number(row.frequency_per_month),
      scopes: JSON.parse(String(row.scopes ?? "[]")) as string[],
    };
  });
}

export async function getContentTemplateBySlug(slug: string): Promise<ContentTemplate | null> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT * FROM content_templates WHERE slug = ? LIMIT 1`,
    args: [slug],
  });
  if (result.rows.length === 0) return null;
  const row = rowToObj(result.rows[0]);
  return {
    id: Number(row.id),
    slug: String(row.slug),
    content_type: row.content_type as ContentTemplate["content_type"],
    mode: (String(row.mode ?? "hook_seeded")) as ContentTemplate["mode"],
    display_name_fr: String(row.display_name_fr),
    display_name_en: String(row.display_name_en),
    prompt_pattern_fr: String(row.prompt_pattern_fr),
    prompt_pattern_en: String(row.prompt_pattern_en),
    image_strategy: String(row.image_strategy),
    active: Number(row.active) === 1,
    frequency_per_month: Number(row.frequency_per_month),
    scopes: JSON.parse(String(row.scopes ?? "[]")) as string[],
  };
}

export interface ContentHook {
  id: number;
  categoryId: number;
  language: "FR" | "EN";
  text: string;
  productScopes: string[];
  mode: "pool" | "generative_seeded";
  usedCount: number;
  lastUsedAt: number | null;
}

export async function getRecentHookCategoryIds(limit = 5): Promise<number[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT DISTINCT h.category_id FROM hook_usage_history u
          JOIN content_hooks h ON h.id = u.hook_id
          ORDER BY u.used_at DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((r) => Number(rowToObj(r).category_id));
}

/**
 * Hook IDs used within the last `days` days (from hook_usage_history).
 * Used to exclude recently-seeded hooks so the same hook does not appear in
 * multiple drafts within a short window.
 */
export async function getRecentlyUsedHookIds(days = 7): Promise<number[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT DISTINCT hook_id FROM hook_usage_history
          WHERE used_at >= strftime('%s','now') - ? * 86400`,
    args: [days],
  });
  return result.rows.map((r) => Number(rowToObj(r).hook_id));
}

export async function selectCompatibleHooks(
  scope: string,
  language: "FR" | "EN",
  excludeCategoryIds: number[],
  excludeHookIds: number[] = []
): Promise<ContentHook[]> {
  const db = await ensureSchema();
  const universalPattern = `%"universal"%`;
  const scopePattern = `%"${scope}"%`;
  let sql = `SELECT * FROM content_hooks WHERE language = ? AND (product_scopes LIKE ? OR product_scopes LIKE ?)`;
  const args: InValue[] = [language, universalPattern, scopePattern];
  if (excludeCategoryIds.length > 0) {
    const placeholders = excludeCategoryIds.map(() => "?").join(", ");
    sql += ` AND category_id NOT IN (${placeholders})`;
    args.push(...excludeCategoryIds);
  }
  if (excludeHookIds.length > 0) {
    const placeholders = excludeHookIds.map(() => "?").join(", ");
    sql += ` AND id NOT IN (${placeholders})`;
    args.push(...excludeHookIds);
  }
  sql += ` ORDER BY used_count ASC, last_used_at ASC NULLS FIRST LIMIT 10`;
  const result = await db.execute({ sql, args });
  return result.rows.map((r) => {
    const o = rowToObj(r);
    let scopes: string[] = [];
    try { scopes = JSON.parse(o.product_scopes as string); } catch { scopes = ["universal"]; }
    return {
      id: Number(o.id),
      categoryId: Number(o.category_id),
      language: o.language as "FR" | "EN",
      text: o.text as string,
      productScopes: scopes,
      mode: (o.mode as "pool" | "generative_seeded") || "pool",
      usedCount: Number(o.used_count || 0),
      lastUsedAt: o.last_used_at != null ? Number(o.last_used_at) : null,
    };
  });
}

export async function recordHookUsage(hookId: number, draftId: number | null): Promise<void> {
  const db = await ensureSchema();
  await db.batch([
    {
      sql: `INSERT INTO hook_usage_history (hook_id, draft_id) VALUES (?, ?)`,
      args: [hookId, draftId],
    },
    {
      sql: `UPDATE content_hooks SET used_count = used_count + 1, last_used_at = strftime('%s','now') WHERE id = ?`,
      args: [hookId],
    },
  ], "write");
}

export async function getHookById(id: number): Promise<ContentHook | null> {
  const db = await ensureSchema();
  const result = await db.execute({ sql: `SELECT * FROM content_hooks WHERE id = ?`, args: [id] });
  if (result.rows.length === 0) return null;
  const o = rowToObj(result.rows[0]);
  let scopes: string[] = [];
  try { scopes = JSON.parse(o.product_scopes as string); } catch { scopes = ["universal"]; }
  return {
    id: Number(o.id),
    categoryId: Number(o.category_id),
    language: o.language as "FR" | "EN",
    text: o.text as string,
    productScopes: scopes,
    mode: (o.mode as "pool" | "generative_seeded") || "pool",
    usedCount: Number(o.used_count || 0),
    lastUsedAt: o.last_used_at != null ? Number(o.last_used_at) : null,
  };
}

export async function seedHooksIfEmpty(): Promise<void> {
  const db = getDb();
  const countRow = await db.execute(`SELECT COUNT(*) as n FROM content_hooks`);
  const count = Number(rowToObj(countRow.rows[0]).n || 0);
  if (count > 0) return;

  // Import dynamically to keep bundle size down (seed only runs once per DB lifetime)
  const { HOOK_CATEGORIES, HOOKS_SEED } = await import("@/lib/seed/hooks-seed");

  await db.batch(
    HOOK_CATEGORIES.map((c) => ({
      sql: `INSERT OR IGNORE INTO content_hook_categories (id, name_fr, name_en, description) VALUES (?, ?, ?, ?)`,
      args: [c.id, c.name_fr, c.name_en, c.description],
    })),
    "write"
  );

  await db.batch(
    HOOKS_SEED.map((h) => ({
      sql: `INSERT OR IGNORE INTO content_hooks (category_id, language, text, product_scopes, mode) VALUES (?, ?, ?, ?, ?)`,
      args: [h.categoryId, h.language, h.text, JSON.stringify(h.productScopes), h.mode],
    })),
    "write"
  );
}

function mapDraft(row: Record<string, unknown>): FacebookDraft {
  let channels: Record<string, ChannelState> = {};
  const raw = row.channels;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      channels = JSON.parse(raw);
    } catch {
      channels = {};
    }
  }
  const imageUrl = (row.image_url as string) || null;
  let imageUrls: string[] = [];
  const rawUrls = row.image_urls;
  if (typeof rawUrls === "string" && rawUrls.length > 0) {
    try {
      const parsed = JSON.parse(rawUrls);
      if (Array.isArray(parsed)) imageUrls = parsed.filter((u): u is string => typeof u === "string" && u.length > 0);
    } catch {
      imageUrls = [];
    }
  }
  // Legacy drafts: fall back to single image_url so publish/render still works pre-backfill.
  if (imageUrls.length === 0 && imageUrl) imageUrls = [imageUrl];
  return {
    id: Number(row.id),
    sku: row.sku as string,
    triggerType: row.trigger_type as string,
    language: row.language as string,
    postText: row.post_text as string,
    postTextEn: (row.post_text_en as string) || null,
    imagePath: (row.image_path as string) || null,
    imageUrl,
    imageUrls,
    oldPrice: row.old_price != null ? Number(row.old_price) : null,
    newPrice: row.new_price != null ? Number(row.new_price) : null,
    status: row.status as string,
    scheduledAt: row.scheduled_at != null ? Number(row.scheduled_at) : null,
    publishedAt: row.published_at != null ? Number(row.published_at) : null,
    facebookPostId: (row.facebook_post_id as string) || null,
    channels,
    createdAt: Number(row.created_at),
    hookId: row.hook_id != null ? Number(row.hook_id) : null,
    approvedAt: row.approved_at != null ? Number(row.approved_at) : null,
    reviewedBy: (row.reviewed_by as string) || null,
    reviewNotes: (row.review_notes as string) || null,
    unsplashImageUrl: (row.unsplash_image_url as string) || null,
    unsplashPhotographer: (row.unsplash_photographer as string) || null,
    unsplashPhotographerUrl: (row.unsplash_photographer_url as string) || null,
    videoUrl: (row.video_url as string) || null,
    reelsVideoUrl: (row.reels_video_url as string) || null,
    productName: (row.name as string) || undefined,
    productImage: (row.image1 as string) || undefined,
  };
}

export async function createFacebookDraft(draft: {
  sku: string; triggerType: string; language: string; postText: string;
  postTextEn?: string | null;
  imagePath?: string | null;
  /** Public image URL (Aosom CDN). Kept for backward compat with legacy readers. Derived from imageUrls[0] if omitted. */
  imageUrl?: string | null;
  /** Ordered list of public image URLs (1–5). Used for multi-photo Facebook posts. */
  imageUrls?: string[];
  /** Rendered Creatomate video URL, when available. */
  videoUrl?: string | null;
  /** Vertical 9:16 Creatomate video URL for Instagram Reels, when available. */
  reelsVideoUrl?: string | null;
  oldPrice?: number | null; newPrice?: number | null;
  /** FK to content_hooks — which hook seeded this draft's caption. */
  hookId?: number | null;
  /** Unsplash image + attribution (content_template drafts have no product image of their own). */
  unsplashImageUrl?: string | null;
  unsplashPhotographer?: string | null;
  unsplashPhotographerUrl?: string | null;
}): Promise<number> {
  const db = await ensureSchema();
  const urls = (draft.imageUrls ?? []).filter((u) => typeof u === "string" && u.length > 0);
  const primary = draft.imageUrl ?? urls[0] ?? null;
  const urlsJson = urls.length > 0 ? JSON.stringify(urls) : null;
  const result = await db.execute({
    sql: `INSERT INTO facebook_drafts (sku, trigger_type, language, post_text, post_text_en, image_path, image_url, image_urls, video_url, reels_video_url, old_price, new_price, hook_id, unsplash_image_url, unsplash_photographer, unsplash_photographer_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [draft.sku, draft.triggerType, draft.language, draft.postText, draft.postTextEn ?? null, draft.imagePath || null, primary, urlsJson, draft.videoUrl ?? null, draft.reelsVideoUrl ?? null, draft.oldPrice ?? null, draft.newPrice ?? null, draft.hookId ?? null, draft.unsplashImageUrl ?? null, draft.unsplashPhotographer ?? null, draft.unsplashPhotographerUrl ?? null],
  });
  return Number(result.lastInsertRowid);
}

/**
 * Merge a single channel's state into the JSON column atomically.
 * Uses SQLite's json_set so parallel publishes to different channels don't clobber each other.
 * channelKey is restricted to a-z/0-9/_ to keep the JSON path safe for SQL interpolation.
 */
export async function setDraftChannelState(id: number, channelKey: string, state: ChannelState): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(channelKey)) {
    throw new Error(`Invalid channelKey: ${channelKey}`);
  }
  const db = await ensureSchema();
  // json_set(COALESCE(channels, '{}'), '$.fb_ameublo', json(?)) mutates just the one key in-place.
  // This is a single UPDATE so it races cleanly under concurrent writes to different channels.
  await db.execute({
    sql: `UPDATE facebook_drafts SET channels = json_set(COALESCE(channels, '{}'), ?, json(?)) WHERE id = ?`,
    args: [`$.${channelKey}`, JSON.stringify(state), id],
  });
}

export async function getFacebookDrafts(filters?: { status?: string; limit?: number }): Promise<FacebookDraft[]> {
  const db = await ensureSchema();
  let sql = `SELECT fd.*, p.name, p.image1 FROM facebook_drafts fd LEFT JOIN products p ON fd.sku = p.sku`;
  const args: InValue[] = [];
  if (filters?.status) { sql += ` WHERE fd.status = ?`; args.push(filters.status); }
  sql += ` ORDER BY fd.created_at DESC`;
  if (filters?.limit) { sql += ` LIMIT ?`; args.push(filters.limit); }
  const result = await db.execute({ sql, args });
  return result.rows.map((r) => mapDraft(rowToObj(r)));
}

export async function getFacebookDraft(id: number): Promise<FacebookDraft | null> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT fd.*, p.name, p.image1 FROM facebook_drafts fd LEFT JOIN products p ON fd.sku = p.sku WHERE fd.id = ?`,
    args: [id],
  });
  return result.rows.length > 0 ? mapDraft(rowToObj(result.rows[0])) : null;
}

/**
 * Currently-scheduled drafts reduced to what the auto-scheduler needs: the slot
 * timestamp + which languages each occupies. Used to compute per-slot occupancy.
 */
export async function getScheduledDraftSlots(): Promise<Array<{ scheduledAt: number | null; fr: boolean; en: boolean }>> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT scheduled_at, post_text, post_text_en FROM facebook_drafts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL`,
  );
  return result.rows.map((row) => {
    const o = rowToObj(row);
    return {
      scheduledAt: o.scheduled_at != null ? Number(o.scheduled_at) : null,
      fr: !!o.post_text && String(o.post_text).trim() !== "",
      en: !!o.post_text_en && String(o.post_text_en).trim() !== "",
    };
  });
}

export async function updateFacebookDraft(id: number, fields: Record<string, unknown>): Promise<void> {
  const db = await ensureSchema();
  const allowed = new Set(["post_text", "post_text_en", "image_path", "image_url", "image_urls", "status", "scheduled_at", "published_at", "facebook_post_id", "channels", "publish_error"]);
  const sets: string[] = [];
  const args: InValue[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) throw new Error(`Invalid column: ${key}`);
    sets.push(`${key} = ?`);
    args.push(value as InValue);
  }
  if (sets.length === 0) return;
  args.push(id);
  await db.execute({ sql: `UPDATE facebook_drafts SET ${sets.join(", ")} WHERE id = ?`, args });
}

/**
 * Atomically claim a scheduled draft for publishing.
 * Returns true if claim succeeded (rowsAffected === 1), false if another
 * instance already claimed it or its status is no longer 'scheduled'.
 * Prevents double-posting when Vercel runs two cron instances in parallel.
 */
export async function claimFacebookDraft(id: number): Promise<boolean> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE facebook_drafts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'`,
    args: [id],
  });
  return (result.rowsAffected ?? 0) === 1;
}

export async function deleteFacebookDraft(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `DELETE FROM facebook_drafts WHERE id = ?`, args: [id] });
}

// ─── Publication Queue ───────────────────────────────────────────────
//
// Unified scheduling queue (social posts / Shopify drafts / blog articles).
// Unlike facebook_drafts (unix-seconds integers), all timestamps here are
// SQLite datetime() TEXT — 'YYYY-MM-DD HH:MM:SS' UTC — so the `<=` slot scan in
// getNextPending compares lexicographically against datetime('now'). Producers
// MUST store slots in that exact format (see toSqliteUtc in draft-scheduler).

export type QueueContentType = "social" | "draft" | "blog" | "video";
export type QueuePlatform = "facebook" | "instagram" | "both" | "shopify_blog";
export type QueueStatus = "pending" | "publishing" | "published" | "failed" | "cancelled";

export interface PublicationQueueItem {
  id: number;
  contentType: QueueContentType;
  contentId: string;
  platform: QueuePlatform;
  payload: string; // JSON-stringified content
  scheduledAt: string; // SQLite datetime TEXT (UTC)
  status: QueueStatus;
  error: string | null;
  createdAt: string;
  publishedAt: string | null;
}

function mapQueueItem(o: Record<string, unknown>): PublicationQueueItem {
  return {
    id: Number(o.id),
    contentType: o.content_type as QueueContentType,
    contentId: String(o.content_id),
    platform: o.platform as QueuePlatform,
    payload: String(o.payload),
    scheduledAt: String(o.scheduled_at),
    status: o.status as QueueStatus,
    error: (o.error as string) || null,
    createdAt: String(o.created_at),
    publishedAt: (o.published_at as string) || null,
  };
}

/** Thrown when a slot is already taken on a platform (partial-unique-index violation). */
export class QueueSlotTakenError extends Error {
  constructor(platform: string, scheduledAt: string) {
    super(`Slot ${scheduledAt} already taken on platform '${platform}'`);
    this.name = "QueueSlotTakenError";
  }
}

/**
 * Queue a single item for publishing at `scheduledAt` (SQLite datetime TEXT, UTC).
 * Rejects a malformed `scheduledAt` up front: the due-check in getNextPending is a
 * lexicographic compare, so a non-'YYYY-MM-DD HH:MM:SS' value would silently never be due.
 * Surfaces the partial-unique-index conflict as QueueSlotTakenError so callers can react
 * (e.g. recompute the next free slot) instead of seeing a raw SQLite error.
 */
export async function addToQueue(item: {
  contentType: QueueContentType;
  contentId: string;
  platform: QueuePlatform;
  payload: string;
  scheduledAt: string;
}): Promise<number> {
  if (!isSqliteUtc(item.scheduledAt)) {
    throw new Error(`addToQueue: scheduledAt must be 'YYYY-MM-DD HH:MM:SS' (got '${item.scheduledAt}')`);
  }
  const db = await ensureSchema();
  try {
    const result = await db.execute({
      sql: `INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [item.contentType, item.contentId, item.platform, item.payload, item.scheduledAt],
    });
    return Number(result.lastInsertRowid);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      throw new QueueSlotTakenError(item.platform, item.scheduledAt);
    }
    throw err;
  }
}

/**
 * Due pending items (scheduled_at at/before now), oldest slot first. The consumer
 * cron drains this, calling markPublished / markFailed per item. Served by
 * idx_publication_queue_status_scheduled.
 */
export async function getNextPending(limit = 10): Promise<PublicationQueueItem[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT * FROM publication_queue
          WHERE status = 'pending' AND scheduled_at <= datetime('now')
          ORDER BY scheduled_at ASC
          LIMIT ?`,
    args: [limit],
  });
  return result.rows.map((r) => mapQueueItem(rowToObj(r)));
}

/**
 * Atomically claim a pending item for publishing (pending → publishing). Returns true if
 * this caller won the claim (rowsAffected === 1), false if another cron instance already
 * took it. The consumer cron MUST claim before publishing so Vercel's overlapping cron
 * instances never double-publish the same item — mirrors claimFacebookDraft.
 */
export async function claimQueueItem(id: number): Promise<boolean> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE publication_queue SET status = 'publishing' WHERE id = ? AND status = 'pending'`,
    args: [id],
  });
  return (result.rowsAffected ?? 0) === 1;
}

export async function markPublished(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE publication_queue SET status = 'published', published_at = datetime('now'), error = NULL WHERE id = ?`,
    args: [id],
  });
}

export async function markFailed(id: number, error: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE publication_queue SET status = 'failed', error = ? WHERE id = ?`,
    args: [error, id],
  });
}

/** All pending items (regardless of due time), oldest slot first — for the dashboard. */
export async function getPendingQueue(): Promise<PublicationQueueItem[]> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT * FROM publication_queue WHERE status = 'pending' ORDER BY scheduled_at ASC`,
  );
  return result.rows.map((r) => mapQueueItem(rowToObj(r)));
}

/**
 * Slot timestamps (SQLite datetime TEXT) already taken on `platform` by an active
 * (pending, publishing, or published) queue item — the same predicate as the partial
 * unique index, so the next-free-slot search and the integrity backstop agree. Failed/
 * cancelled items free their slot.
 */
export async function getOccupiedQueueSlots(platform: string): Promise<string[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT scheduled_at FROM publication_queue WHERE platform = ? AND status IN ('pending', 'publishing', 'published')`,
    args: [platform],
  });
  return result.rows.map((r) => String(rowToObj(r).scheduled_at));
}

/**
 * Cancel a content item's still-pending queue rows (pending → cancelled), freeing their
 * slots for rebooking. 'publishing'/'published' rows are left untouched (already in flight
 * or done). Used when an operator re-schedules (cancel-then-enqueue) or unschedules a draft.
 * Returns the number of rows cancelled.
 */
export async function cancelPendingQueueItems(
  contentType: QueueContentType,
  contentId: string,
): Promise<number> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `UPDATE publication_queue SET status = 'cancelled' WHERE content_type = ? AND content_id = ? AND status = 'pending'`,
    args: [contentType, contentId],
  });
  return result.rowsAffected ?? 0;
}

// ─── Demand Gen video assets ─────────────────────────────────────────

export interface DemandGenAsset {
  id: number;
  sku: string;
  shopifyProductId: string | null;
  titleFr: string | null;
  ratio: string;
  durationSec: number;
  blobPath: string;
  blobUrl: string;
  bytes: number | null;
  metaVideoId: string | null;
  metaStatus: string | null;
  youtubeVideoId: string | null;
  youtubeStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

function mapDemandGenAsset(o: Record<string, unknown>): DemandGenAsset {
  return {
    id: Number(o.id),
    sku: String(o.sku),
    shopifyProductId: (o.shopify_product_id as string) || null,
    titleFr: (o.title_fr as string) || null,
    ratio: String(o.ratio),
    durationSec: Number(o.duration_sec),
    blobPath: String(o.blob_path),
    blobUrl: String(o.blob_url),
    bytes: o.bytes == null ? null : Number(o.bytes),
    metaVideoId: (o.meta_video_id as string) || null,
    metaStatus: (o.meta_status as string) || null,
    youtubeVideoId: (o.youtube_video_id as string) || null,
    youtubeStatus: (o.youtube_status as string) || null,
    createdAt: Number(o.created_at),
    updatedAt: Number(o.updated_at),
  };
}

/**
 * All Demand Gen video assets (one row per sku/ratio/duration), ordered for the
 * dashboard table. Read-only; the table is populated by scripts/load-demand-gen-db.mjs
 * and the Meta/YouTube ad-push jobs. meta_video_id / youtube_video_id stay null until
 * the asset is uploaded to that platform.
 */
export async function getDemandGenAssets(): Promise<DemandGenAsset[]> {
  const db = await ensureSchema();
  const result = await db.execute(
    `SELECT * FROM video_demand_gen ORDER BY sku ASC, ratio ASC, duration_sec ASC`,
  );
  return result.rows.map((r) => mapDemandGenAsset(rowToObj(r)));
}

// ─── Auto-post daily counter ─────────────────────────────────────────

function todayKey(): string {
  // YYYY-MM-DD in UTC
  return new Date().toISOString().slice(0, 10);
}

export async function getAutopostCountToday(): Promise<number> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT count FROM social_autopost_counter WHERE day = ?`, args: [todayKey()] });
  if (r.rows.length === 0) return 0;
  return Number(rowToObj(r.rows[0]).count || 0);
}

export async function incrementAutopostCountToday(): Promise<number> {
  const db = await ensureSchema();
  const day = todayKey();
  await db.execute({
    sql: `INSERT INTO social_autopost_counter (day, count) VALUES (?, 1)
          ON CONFLICT(day) DO UPDATE SET count = count + 1`,
    args: [day],
  });
  const r = await db.execute({ sql: `SELECT count FROM social_autopost_counter WHERE day = ?`, args: [day] });
  return Number(rowToObj(r.rows[0]).count || 0);
}

// ─── Blog auto-publish: weekly cap ───────────────────────────────────

/**
 * Atomically reserve one publish slot for `week` if the count is below `cap`.
 * Returns true if a slot was reserved (caller may publish), false if the cap is reached.
 * The conditional upsert makes "check < cap AND increment" a single statement, so two
 * concurrent runs can't both slip past the cap. Release the slot if the publish then
 * fails (see releaseBlogPublishSlot).
 */
export async function reserveBlogPublishSlot(week: string, cap: number): Promise<boolean> {
  if (cap < 1) return false; // cap 0 → never auto-publish (the INSERT path would bypass the WHERE)
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `INSERT INTO blog_publish_counter (week, count) VALUES (?, 1)
          ON CONFLICT(week) DO UPDATE SET count = count + 1 WHERE count < ?
          RETURNING count`,
    args: [week, cap],
  });
  // INSERT (new week) or a satisfied conditional UPDATE returns a row; an at-cap conflict
  // updates nothing and returns no row.
  return r.rows.length > 0;
}

/** Give back a slot reserved via reserveBlogPublishSlot when the publish ultimately failed. */
export async function releaseBlogPublishSlot(week: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE blog_publish_counter SET count = MAX(0, count - 1) WHERE week = ?`,
    args: [week],
  });
}

export async function getLastPostDate(sku: string): Promise<number | null> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT MAX(published_at) as last FROM facebook_drafts WHERE sku = ? AND status = 'published'`,
    args: [sku],
  });
  if (result.rows.length === 0) return null;
  const val = rowToObj(result.rows[0]).last;
  return val != null ? Number(val) : null;
}

export async function getEligibleHighlightProduct(minDaysBetween: number): Promise<Record<string, unknown> | null> {
  const db = await ensureSchema();
  const cutoff = Math.floor(Date.now() / 1000) - minDaysBetween * 86400;

  // Two-step pattern: fetch eligible SKUs only (fast ~4s), then pick randomly in JS.
  // ORDER BY RANDOM() on 10k+ products forces a full table scan on Turso = 60-82s,
  // which exceeds Vercel's 120s maxDuration and causes 504 on the social cron.
  const skusResult = await db.execute({
    sql: `SELECT sku FROM products
          WHERE shopify_product_id IS NOT NULL AND qty > 0
            AND (last_posted_at IS NULL OR last_posted_at < ?)`,
    args: [cutoff],
  });

  if (skusResult.rows.length === 0) return null;

  const skus = skusResult.rows.map((r) => (r as unknown as Record<string, unknown>).sku as string);
  const randomSku = skus[Math.floor(Math.random() * skus.length)];

  // Re-validate eligibility to guard against sync-race: a concurrent sync run
  // could zero qty or clear shopify_product_id between the two queries.
  const result = await db.execute({
    sql: `SELECT * FROM products WHERE sku = ? AND shopify_product_id IS NOT NULL AND qty > 0`,
    args: [randomSku],
  });
  return result.rows.length > 0 ? rowToObj(result.rows[0]) : null;
}

export async function markProductPosted(sku: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE products SET last_posted_at = strftime('%s','now') WHERE sku = ?`, args: [sku] });
}

// ─── Phase 2 helpers ─────────────────────────────────────────────────

/**
 * Read all products from the DB and return them as AosomProduct objects.
 * Used by Phase 2 (runShopifyPush) to avoid re-fetching the full CSV.
 * Fields not stored in the DB (psin, dimensions, brand, etc.) are set to
 * safe defaults — they are not needed for diff computation.
 */
export async function getAllProductsAsAosom(): Promise<AosomProduct[]> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT sku, name, price, qty, color, size, product_type,
            image1, image2, image3, image4, image5, image6, image7,
            video, description, short_description, material, gtin,
            weight, out_of_stock_expected, estimated_arrival
     FROM products
     WHERE last_seen_at >= strftime('%s', date('now'))`,
    args: [],
  });
  return result.rows.map((r) => {
    const o = rowToObj(r);
    const images = [o.image1, o.image2, o.image3, o.image4, o.image5, o.image6, o.image7]
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    return {
      sku: String(o.sku ?? ""),
      name: String(o.name ?? ""),
      price: Number(o.price ?? 0),
      qty: Number(o.qty ?? 0),
      color: String(o.color ?? ""),
      size: String(o.size ?? ""),
      productType: String(o.product_type ?? ""),
      images,
      video: String(o.video ?? ""),
      description: String(o.description ?? ""),
      shortDescription: String(o.short_description ?? ""),
      material: String(o.material ?? ""),
      gtin: String(o.gtin ?? ""),
      weight: Number(o.weight ?? 0),
      estimatedArrival: String(o.estimated_arrival ?? ""),
      outOfStockExpected: String(o.out_of_stock_expected ?? ""),
      // Fields not stored in DB — safe defaults (not used for diff computation)
      dimensions: { length: 0, width: 0, height: 0 },
      brand: "",
      category: "",
      psin: "",
      sin: "",
      pdf: "",
      packageNum: "",
      boxSize: "",
      boxWeight: "",
    } satisfies AosomProduct;
  });
}

// ─── Phase 2 checkpoint (cross-cron progress tracking) ───────────────

export interface ShopifyPushCheckpoint {
  date: string;
  processedGroupKeys: string[];
  totalDiffs: number;
  totalUpdates: number;
  totalArchived: number;
  totalErrors: number;
  done: boolean;
}

export function isValidCheckpoint(v: unknown): v is ShopifyPushCheckpoint {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.date === "string" &&
    Array.isArray(c.processedGroupKeys) &&
    typeof c.totalDiffs === "number" &&
    typeof c.totalUpdates === "number" &&
    typeof c.totalArchived === "number" &&
    typeof c.totalErrors === "number" &&
    typeof c.done === "boolean"
  );
}

export async function getShopifyPushCheckpoint(): Promise<ShopifyPushCheckpoint | null> {
  const raw = await getSetting("shopify_push_checkpoint");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidCheckpoint(parsed)) {
      console.warn("[DB] checkpoint corrupted, discarding:", raw.slice(0, 100));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─── CSV Blob Cache ────────────────────────────────────────────────────────────

export interface CsvBlobCache {
  blob_url: string;
  blob_key: string;
  csv_size_bytes: number;
  fetched_at: string;
  upload_duration_ms: number;
  download_duration_ms: number;
}

export async function getCachedBlobUrl(): Promise<CsvBlobCache | null> {
  const db = getDb();
  await initSchema();
  const { rows } = await db.execute({
    sql: `SELECT blob_url, blob_key, csv_size_bytes, fetched_at,
                 upload_duration_ms, download_duration_ms
          FROM csv_blob_cache WHERE id = 1`,
    args: [],
  });
  if (!rows[0]) return null;
  const r = rows[0] as unknown as Record<string, unknown>;
  return {
    blob_url: String(r.blob_url),
    blob_key: String(r.blob_key),
    csv_size_bytes: Number(r.csv_size_bytes),
    fetched_at: String(r.fetched_at),
    upload_duration_ms: Number(r.upload_duration_ms),
    download_duration_ms: Number(r.download_duration_ms),
  };
}

export async function upsertBlobCache(cache: Omit<CsvBlobCache, "fetched_at">): Promise<void> {
  const db = getDb();
  await initSchema();
  await db.execute({
    sql: `INSERT INTO csv_blob_cache
          (id, blob_url, blob_key, csv_size_bytes, upload_duration_ms, download_duration_ms)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            blob_url = excluded.blob_url,
            blob_key = excluded.blob_key,
            csv_size_bytes = excluded.csv_size_bytes,
            upload_duration_ms = excluded.upload_duration_ms,
            download_duration_ms = excluded.download_duration_ms,
            fetched_at = datetime('now')`,
    args: [cache.blob_url, cache.blob_key, cache.csv_size_bytes, cache.upload_duration_ms, cache.download_duration_ms],
  });
}

/** Returns true if the cache is older than max_age_hours (default 12h). */
export function isCacheStale(fetched_at: string, max_age_hours = 12): boolean {
  const tsNormalized = fetched_at.replace(" ", "T") + (fetched_at.endsWith("Z") ? "" : "Z");
  const ageMs = Date.now() - new Date(tsNormalized).getTime();
  return ageMs > max_age_hours * 3600 * 1000;
}

export async function saveShopifyPushCheckpoint(cp: ShopifyPushCheckpoint): Promise<void> {
  await setSetting("shopify_push_checkpoint", JSON.stringify(cp));
}

// ─── Phase 1 chunked checkpoint ────────────────────────────────────────────────

export interface Phase1Checkpoint {
  date: string;
  blobUrl: string;
  totalChunks: number;
  chunksProcessed: number;
  refreshDone: boolean;
  finalized: boolean;
  totalProducts: number;
  priceUpdates: number;
  stockChanges: number;
  newProducts: number;
}

function isValidPhase1Checkpoint(v: unknown): v is Phase1Checkpoint {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.date === "string" &&
    typeof c.blobUrl === "string" &&
    typeof c.totalChunks === "number" &&
    typeof c.chunksProcessed === "number" &&
    typeof c.refreshDone === "boolean" &&
    typeof c.finalized === "boolean" &&
    typeof c.totalProducts === "number" &&
    typeof c.priceUpdates === "number" &&
    typeof c.stockChanges === "number" &&
    typeof c.newProducts === "number"
  );
}

export async function getPhase1Checkpoint(): Promise<Phase1Checkpoint | null> {
  const raw = await getSetting("phase1_checkpoint");
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPhase1Checkpoint(parsed)) {
      console.warn("[DB] phase1_checkpoint corrupted, discarding:", raw.slice(0, 100));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function savePhase1Checkpoint(cp: Phase1Checkpoint): Promise<void> {
  await setSetting("phase1_checkpoint", JSON.stringify(cp));
}

/** Returns the first available product SKU, used as a fallback for non-product drafts. */
export async function getAnyProductSku(): Promise<string | null> {
  const db = await ensureSchema();
  const result = await db.execute(`SELECT sku FROM products LIMIT 1`);
  if (result.rows.length === 0) return null;
  return String(rowToObj(result.rows[0]).sku);
}

// ─── Drafts Review ───────────────────────────────────────────────────────────

export interface DraftFilters {
  statuses?: string[];    // default: all non-published
  // 'content_template' | 'new_product' | 'stock_highlight' (exact trigger_type),
  // or the group 'products' (= new_product + stock_highlight), or undefined = all.
  triggerType?: string;
  hook?: "with" | "without" | "all";
  since?: number;         // unix timestamp
  until?: number;         // unix timestamp
  page?: number;
  pageSize?: number;
}

// Product-type drafts (auto-generated from the catalog) vs content_template
// drafts (curated editorial content). The drafts UI groups the two product
// triggers under one "Produits" filter.
export const PRODUCT_TRIGGER_TYPES = ["new_product", "stock_highlight"] as const;

/**
 * Build the trigger_type WHERE fragment for a drafts query.
 * - undefined / "" / "all" → null (no filter)
 * - "products"            → trigger_type IN (new_product, stock_highlight)
 * - any other value       → exact trigger_type = ?
 * Returns null when no filter should be applied.
 */
export function triggerTypeClause(
  triggerType: string | undefined | null,
): { sql: string; args: string[] } | null {
  if (!triggerType || triggerType === "all") return null;
  if (triggerType === "products") {
    return {
      sql: `fd.trigger_type IN (${PRODUCT_TRIGGER_TYPES.map(() => "?").join(", ")})`,
      args: [...PRODUCT_TRIGGER_TYPES],
    };
  }
  return { sql: `fd.trigger_type = ?`, args: [triggerType] };
}

export interface DraftsPage {
  items: FacebookDraft[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export async function getDraftsForReview(filters: DraftFilters = {}): Promise<DraftsPage> {
  const db = await ensureSchema();
  const {
    statuses,
    triggerType,
    hook = "all",
    since,
    until,
    page = 1,
    pageSize = 20,
  } = filters;

  const where: string[] = [];
  const args: InValue[] = [];

  if (statuses && statuses.length > 0) {
    where.push(`fd.status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  } else {
    where.push(`fd.status != 'published'`);
  }

  const trig = triggerTypeClause(triggerType);
  if (trig) {
    where.push(trig.sql);
    args.push(...trig.args);
  }
  if (hook === "with") {
    where.push(`fd.hook_id IS NOT NULL`);
  } else if (hook === "without") {
    where.push(`fd.hook_id IS NULL`);
  }
  if (since != null) {
    where.push(`fd.created_at >= ?`);
    args.push(since);
  }
  if (until != null) {
    where.push(`fd.created_at <= ?`);
    args.push(until);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const offset = (page - 1) * pageSize;

  const [countRes, rowsRes] = await Promise.all([
    db.execute({ sql: `SELECT COUNT(*) as n FROM facebook_drafts fd ${whereClause}`, args }),
    db.execute({
      sql: `SELECT fd.*, p.name, p.image1 FROM facebook_drafts fd
            LEFT JOIN products p ON fd.sku = p.sku
            ${whereClause}
            ORDER BY fd.created_at DESC
            LIMIT ? OFFSET ?`,
      args: [...args, pageSize, offset],
    }),
  ]);

  const total = Number(rowToObj(countRes.rows[0]).n);
  const items = rowsRes.rows.map((r) => mapDraft(rowToObj(r)));

  return { items, total, page, pageSize, hasMore: offset + items.length < total };
}

export async function approveDraftDb(id: number, reviewedBy = "admin"): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE facebook_drafts SET status = 'approved', approved_at = strftime('%s','now'), reviewed_by = ? WHERE id = ?`,
    args: [reviewedBy, id],
  });
}

export async function rejectDraftDb(id: number, notes: string, reviewedBy = "admin"): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `UPDATE facebook_drafts SET status = 'rejected', approved_at = strftime('%s','now'), reviewed_by = ?, review_notes = ? WHERE id = ?`,
    args: [reviewedBy, notes, id],
  });
}

/**
 * TTL cleanup: auto-reject still-unapproved `new_product` drafts older than `maxAgeDays`.
 * A "new product" announcement loses relevance after ~a week, and the publication queue
 * can't drain the backlog (generation outpaces publishing), so stale ones are rejected —
 * kept for audit (status='rejected', reviewed_by='auto-ttl'), never published. Only touches
 * status='draft' rows, so an approved/queued draft is never affected. Returns rows expired.
 */
export async function expireStaleNewProductDrafts(maxAgeDays = 7): Promise<number> {
  const db = await ensureSchema();
  const res = await db.execute({
    sql: `UPDATE facebook_drafts
          SET status = 'rejected', approved_at = strftime('%s','now'), reviewed_by = 'auto-ttl', review_notes = ?
          WHERE status = 'draft' AND trigger_type = 'new_product'
            AND created_at < unixepoch() - 86400 * ?`,
    args: [`Auto-expiré: new_product >${maxAgeDays}j`, maxAgeDays],
  });
  return res.rowsAffected;
}
