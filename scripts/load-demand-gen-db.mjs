// Loader: persist the rendered+uploaded Demand Gen video assets from
// out/demand-gen-manifest.json into the Turso `video_demand_gen` table, and
// emit a committed human-readable snapshot at docs/demand-gen-urls.json.
//
// The manifest is gitignored; this table + snapshot are the durable record the
// downstream ad-push jobs read from (Meta advideos file_url ingest, YouTube
// upload for Google Demand Gen).
//
// Usage:
//   node scripts/load-demand-gen-db.mjs            # dry-run (default): no DB write
//   node scripts/load-demand-gen-db.mjs --apply    # upsert into Turso
//
// Both modes (re)write docs/demand-gen-urls.json so the snapshot can be reviewed
// and committed without touching the database.
//
// IMPORTANT: --apply talks to the network DB. On Windows ARM64 run it under x64
// node (bun-x64 crashes on network scripts) — see CLAUDE.md "Windows ARM64".
//
// Idempotent: the table's UNIQUE(sku, ratio, duration_sec) plus an ON CONFLICT
// upsert means re-running refreshes the source fields (blob_url, blob_path,
// bytes, title_fr, shopify_product_id) WITHOUT clobbering the downstream-filled
// meta_video_id / youtube_video_id / *_status columns.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const MANIFEST = join(ROOT, "out", "demand-gen-manifest.json");
const SNAPSHOT = join(ROOT, "docs", "demand-gen-urls.json");

// {sku}_{ratio}_{dur}s.mp4 — e.g. 01-0415_16x9_15s.mp4. SKUs contain hyphens but
// never underscores, so anchoring at the end is unambiguous.
const ASSET_RE = /_(\d+x\d+)_(\d+)s\.mp4$/;

/** Parse ratio ("16:9") + duration_sec (15) from an upload's path. null if unparseable. */
export function parseAsset(pathOrFile) {
  const m = String(pathOrFile || "").match(ASSET_RE);
  if (!m) return null;
  return { ratio: m[1].replace("x", ":"), duration_sec: Number(m[2]) };
}

/**
 * Join manifest.uploads[] (the 87 uploaded files) to manifest.videos[] (metadata)
 * by sku, producing one normalized row per asset. Pure — no timestamps, so it is
 * deterministic and testable. Skips uploads with no blob_url or an unparseable name.
 */
export function buildRows(manifest) {
  const videosBySku = new Map((manifest?.videos || []).map((v) => [v.sku, v]));
  const rows = [];
  for (const u of manifest?.uploads || []) {
    if (!u.blob_url) continue;
    const parsed = parseAsset(u.blob_path || u.file);
    if (!parsed) continue;
    const v = videosBySku.get(u.sku);
    rows.push({
      sku: u.sku,
      shopify_product_id: v?.shopify_product_id ?? null,
      title_fr: v?.title_fr ?? null,
      ratio: parsed.ratio,
      duration_sec: parsed.duration_sec,
      blob_path: u.blob_path ?? null,
      blob_url: u.blob_url,
      bytes: u.bytes ?? null,
    });
  }
  // Stable order so the committed snapshot diffs cleanly.
  rows.sort(
    (a, b) =>
      a.sku.localeCompare(b.sku) ||
      a.ratio.localeCompare(b.ratio) ||
      a.duration_sec - b.duration_sec
  );
  return rows;
}

/** Wrap rows in a small metadata envelope for the committed snapshot. */
export function buildSnapshot(rows, generatedAtIso) {
  return {
    generated_from: "out/demand-gen-manifest.json",
    generated_at: generatedAtIso,
    count: rows.length,
    skus: [...new Set(rows.map((r) => r.sku))].sort(),
    assets: rows,
  };
}

function loadManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (e) {
    console.error(`✗ Cannot read ${MANIFEST}: ${e.message}`);
    process.exit(1);
  }
}

async function main() {
  const APPLY = process.argv.includes("--apply");
  const manifest = loadManifest();
  const rows = buildRows(manifest);

  const expected = manifest?.summary?.total_output_assets;
  console.log(`Demand Gen DB loader (${APPLY ? "APPLY" : "dry-run"})`);
  console.log(`  manifest assets : ${rows.length}${expected ? ` (manifest expects ${expected})` : ""}`);
  console.log(`  distinct skus   : ${new Set(rows.map((r) => r.sku)).size}`);
  console.log(`  ratios          : ${[...new Set(rows.map((r) => r.ratio))].join(", ")}`);
  console.log(`  durations (s)   : ${[...new Set(rows.map((r) => r.duration_sec))].sort((a, b) => a - b).join(", ")}`);
  if (expected && rows.length !== expected) {
    console.log(`  ⚠ row count ${rows.length} ≠ manifest total_output_assets ${expected}`);
  }

  // Always (re)write the committed snapshot — it is a DB-independent artifact.
  const snapshot = buildSnapshot(rows, new Date().toISOString());
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`  ✓ wrote snapshot: ${SNAPSHOT}`);

  if (!APPLY) {
    console.log(`\nDry-run only. Re-run with --apply to upsert into Turso (checkpoint before this).`);
    return;
  }

  // --- DB write (network) -------------------------------------------------
  const { loadEnv } = await import("./_shopify-lib.mjs");
  const { createClient } = await import("@libsql/client");
  const env = loadEnv();
  if (!env.TURSO_DATABASE_URL) {
    console.error("✗ TURSO_DATABASE_URL not found in .env.local");
    process.exit(1);
  }
  const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

  // Self-contained, idempotent DDL (mirrors initSchema in src/lib/database.ts)
  // so the script works even if the app hasn't run initSchema against this DB.
  await db.execute(`CREATE TABLE IF NOT EXISTS video_demand_gen (
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
  )`);

  const now = Math.floor(Date.now() / 1000);
  // ON CONFLICT refreshes only the source-of-truth columns; downstream IDs/status
  // and the original created_at are preserved across re-runs.
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO video_demand_gen
      (sku, shopify_product_id, title_fr, ratio, duration_sec, blob_path, blob_url, bytes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sku, ratio, duration_sec) DO UPDATE SET
        shopify_product_id = excluded.shopify_product_id,
        title_fr           = excluded.title_fr,
        blob_path          = excluded.blob_path,
        blob_url           = excluded.blob_url,
        bytes              = excluded.bytes,
        updated_at         = excluded.updated_at`,
    args: [
      r.sku, r.shopify_product_id, r.title_fr, r.ratio, r.duration_sec,
      r.blob_path, r.blob_url, r.bytes, now, now,
    ],
  }));

  await db.batch(stmts, "write");
  const count = await db.execute("SELECT COUNT(*) AS n FROM video_demand_gen");
  console.log(`\n✓ Upserted ${rows.length} rows. Table now holds ${count.rows[0].n} total.`);
}

// Only run when executed directly (so tests can import the pure helpers).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
