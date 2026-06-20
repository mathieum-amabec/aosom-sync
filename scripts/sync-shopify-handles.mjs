// One-shot: resync products.shopify_handle (Turso) from the live Shopify handles.
// Handles drift when a product is renamed in Shopify admin but the daily sync doesn't
// rewrite the stored handle. URLs built from the stale handle still work via Shopify's
// 301 but take a needless hop.
//
// Usage (run under node x64 — see CLAUDE.md):
//   node scripts/sync-shopify-handles.mjs          # DRY-RUN: print diff, write checkpoint
//   node scripts/sync-shopify-handles.mjs --apply   # replay checkpoint -> UPDATE DB rows
//
// No DB write without --apply. --apply executes exactly the diff captured at dry-run time.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { loadEnv, gql } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECKPOINT = join(__dirname, ".sync-shopify-handles.checkpoint.json");
const APPLY = process.argv.includes("--apply");

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;

// 1. Pull every live product handle from Shopify (GraphQL, 250/page).
async function fetchLiveHandles() {
  const map = new Map(); // numericId -> handle
  let cursor = null;
  for (;;) {
    const json = await gql(
      `query($cursor: String) {
         products(first: 250, after: $cursor) {
           pageInfo { hasNextPage endCursor }
           nodes { id handle }
         }
       }`,
      { cursor }
    );
    const { nodes, pageInfo } = json.data.products;
    for (const n of nodes) map.set(n.id.split("/").pop(), n.handle);
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return map;
}

// 2. Build the diff: distinct DB products whose stored handle != live handle.
async function buildDiff() {
  const live = await fetchLiveHandles();
  const rows = await q(
    `SELECT DISTINCT shopify_product_id AS id, shopify_handle AS dbHandle
     FROM products
     WHERE shopify_product_id IS NOT NULL AND shopify_handle IS NOT NULL AND shopify_handle != ''`
  );
  const stale = [];
  const missing = []; // in DB but not found live (deleted on Shopify)
  for (const r of rows) {
    const id = String(r.id);
    const liveHandle = live.get(id);
    if (liveHandle === undefined) {
      missing.push({ id, dbHandle: r.dbHandle });
    } else if (liveHandle !== r.dbHandle) {
      stale.push({ id, dbHandle: r.dbHandle, liveHandle });
    }
  }
  return { totalDistinct: rows.length, liveCount: live.size, stale, missing };
}

if (!APPLY) {
  console.log("DRY-RUN — no DB writes. Fetching live handles from Shopify…\n");
  const d = await buildDiff();
  console.log(`Distinct DB products with a handle: ${d.totalDistinct}`);
  console.log(`Live products on Shopify:           ${d.liveCount}`);
  console.log(`STALE (db != live):                 ${d.stale.length}`);
  console.log(`MISSING (in DB, not live):          ${d.missing.length}\n`);
  for (const s of d.stale) {
    console.log(`• product ${s.id}`);
    console.log(`    db:   ${s.dbHandle}`);
    console.log(`    live: ${s.liveHandle}`);
  }
  if (d.missing.length) {
    console.log(`\nMISSING (not updated — product gone from Shopify):`);
    for (const m of d.missing) console.log(`  ${m.id}  ${m.dbHandle}`);
  }
  writeFileSync(CHECKPOINT, JSON.stringify({ savedAt: "dry-run", stale: d.stale }, null, 2));
  console.log(`\nCheckpoint written: ${CHECKPOINT}`);
  console.log(`Re-run with --apply to UPDATE ${d.stale.length} product handle(s).`);
} else {
  if (!existsSync(CHECKPOINT)) throw new Error("No checkpoint — run the dry-run first.");
  const { stale } = JSON.parse(readFileSync(CHECKPOINT, "utf8"));
  console.log(`APPLY — updating ${stale.length} handle(s) from reviewed checkpoint.\n`);
  let updated = 0,
    skipped = 0;
  for (const s of stale) {
    // Drift guard: only update rows still holding the handle we captured.
    const res = await db.execute({
      sql: `UPDATE products SET shopify_handle = ? WHERE shopify_product_id = ? AND shopify_handle = ?`,
      args: [s.liveHandle, s.id, s.dbHandle],
    });
    if (res.rowsAffected > 0) {
      updated++;
      console.log(`✓ ${s.id}: ${s.dbHandle} -> ${s.liveHandle}  (${res.rowsAffected} row(s))`);
    } else {
      skipped++;
      console.log(`= ${s.id}: no row matched "${s.dbHandle}" — skip (already changed?)`);
    }
  }
  console.log(`\nDone. Products updated: ${updated}, skipped: ${skipped}.`);
}
