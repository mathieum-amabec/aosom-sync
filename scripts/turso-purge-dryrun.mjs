// READ-ONLY DRY-RUN purge counts. SELECT COUNT only — NOTHING is deleted.
// Columns corrected against the REAL schema (see turso-purge-audit.mjs output):
//   cron_runs  uses ran_at      (NOT created_at)
//   feed_syncs uses fetched_at  (NOT created_at)
//   video_ingest_log.created_at is TEXT 'YYYY-MM-DD' (NOT epoch); no id column
//   facebook_drafts.created_at + price_history.detected_at are epoch INTEGER
import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const one = async (sql) => (await q(sql))[0];
const line = "=".repeat(72);
// epoch cutoffs (integer seconds) — matches existing scripts' strftime idiom
const E = (d) => `cast(strftime('%s','now','-${d} days') as integer)`;

console.log(line + "\nDRY-RUN PURGE — counts only, NO deletion\n" + line);

// Context: status distribution for facebook_drafts (confirm 'published' exists)
console.log("\nfacebook_drafts status distribution:");
for (const r of await q(`SELECT status, COUNT(*) n FROM facebook_drafts GROUP BY status ORDER BY n DESC`)) {
  console.log(`  ${String(r.status).padEnd(12)} ${r.n}`);
}

// 1) facebook_drafts: published & older than 30 days
const fbTotal = (await one(`SELECT COUNT(*) n FROM facebook_drafts`)).n;
const fbDel = (await one(
  `SELECT COUNT(*) n FROM facebook_drafts WHERE status='published' AND created_at < ${E(30)}`,
)).n;

// 2) video_ingest_log: keep only the 30 most recent (created_at is TEXT date).
//    19 rows total < 30 → 0 deleted. Compute generically anyway.
const viTotal = (await one(`SELECT COUNT(*) n FROM video_ingest_log`)).n;
const viDel = Math.max(0, Number(viTotal) - 30);

// 3) cron_runs: older than 7 days  (column = ran_at, not created_at)
const crTotal = (await one(`SELECT COUNT(*) n FROM cron_runs`)).n;
const crDel = (await one(`SELECT COUNT(*) n FROM cron_runs WHERE ran_at < ${E(7)}`)).n;

// 4) feed_syncs: older than 7 days  (column = fetched_at, not created_at)
const fsTotal = (await one(`SELECT COUNT(*) n FROM feed_syncs`)).n;
const fsDel = (await one(`SELECT COUNT(*) n FROM feed_syncs WHERE fetched_at < ${E(7)}`)).n;

// 5) price_history: older than 90 days  (column = detected_at, epoch int) — THE BIG ONE
const phTotal = (await one(`SELECT COUNT(*) n FROM price_history`)).n;
const phDel = (await one(`SELECT COUNT(*) n FROM price_history WHERE detected_at < ${E(90)}`)).n;
const phOldest = (await one(
  `SELECT datetime(MIN(detected_at),'unixepoch') a, datetime(MAX(detected_at),'unixepoch') b FROM price_history`,
));

const rows = [
  ["facebook_drafts (published >30d)", fbDel, fbTotal],
  ["video_ingest_log (keep 30 newest)", viDel, viTotal],
  ["cron_runs (ran_at >7d)", crDel, crTotal],
  ["feed_syncs (fetched_at >7d)", fsDel, fsTotal],
  ["price_history (detected_at >90d)", phDel, phTotal],
];

console.log("\n" + line + "\nROWS THAT WOULD BE DELETED\n" + line);
console.log(`  ${"target".padEnd(36)} ${"delete".padStart(8)} ${"of total".padStart(10)}`);
let totalDel = 0;
for (const [name, del, tot] of rows) {
  totalDel += Number(del);
  console.log(`  ${name.padEnd(36)} ${String(del).padStart(8)} ${String(tot).padStart(10)}`);
}
console.log("  " + "-".repeat(58));
console.log(`  ${"TOTAL".padEnd(36)} ${String(totalDel).padStart(8)}`);
console.log(`\n  price_history range: ${phOldest.a} → ${phOldest.b}`);
console.log(`\n  ⚠ price_history is the dominant table (${phTotal} rows). The >90d purge`);
console.log(`    removes ${phDel} of them — the main quota win.`);
console.log("\n" + line + "\nDONE — read-only. STOP: awaiting Mat's validation before any DELETE.\n" + line);
await db.close?.();
