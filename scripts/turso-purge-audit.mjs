// READ-ONLY audit for Turso purge planning. No DELETE/UPDATE — pure SELECT.
// ÉTAPE 1: list tables + row counts (find the biggest tables).
// ÉTAPE 2 prep: introspect schema of the 5 purge-target tables so the dry-run
//   queries map to REAL column names/types (created_at/detected_at may be epoch
//   ints or ISO text; table names may differ). We verify before counting.
import { createClient } from "@libsql/client";
import { loadEnv } from "./_shopify-lib.mjs";

const env = loadEnv();
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const q = async (sql, args = []) => (await db.execute({ sql, args })).rows;
const line = "=".repeat(72);

// ── ÉTAPE 1 — all tables + row counts ───────────────────────────────────────
console.log(line + "\nÉTAPE 1 — TABLES & ROW COUNTS\n" + line);
const tables = (await q(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
)).map((r) => String(r.name));

const counts = [];
for (const t of tables) {
  try {
    const n = (await q(`SELECT COUNT(*) AS n FROM "${t}"`))[0].n;
    counts.push({ table: t, rows: Number(n) });
  } catch (e) {
    counts.push({ table: t, rows: -1, err: String(e.message || e) });
  }
}
counts.sort((a, b) => b.rows - a.rows);
for (const c of counts) {
  const tag = c.rows < 0 ? `ERROR: ${c.err}` : String(c.rows).padStart(8);
  console.log(`  ${c.table.padEnd(28)} ${tag}`);
}

// ── Schema introspection for the 5 target tables ────────────────────────────
const targets = [
  "facebook_drafts",
  "video_ingest_log",
  "cron_runs",
  "feed_syncs",
  "price_history",
];
console.log("\n" + line + "\nSCHEMA OF PURGE TARGETS (verify columns/types before dry-run)\n" + line);
const present = new Set(tables);
for (const t of targets) {
  if (!present.has(t)) {
    // look for close matches so we can find the real name
    const near = tables.filter((x) => x.includes(t.split("_")[0]) || t.includes(x.split("_")[0]));
    console.log(`\n  ⚠ TABLE NOT FOUND: ${t}   nearby: ${near.join(", ") || "(none)"}`);
    continue;
  }
  const cols = await q(`PRAGMA table_info("${t}")`);
  const colNames = cols.map((c) => `${c.name}:${c.type || "?"}`);
  console.log(`\n  ${t}  (${counts.find((c) => c.table === t)?.rows} rows)`);
  console.log(`    cols: ${colNames.join(", ")}`);
  // sample the likely timestamp column(s) to learn the format
  for (const tsCol of ["created_at", "detected_at", "ingested_at", "synced_at", "run_at", "started_at"]) {
    if (cols.some((c) => c.name === tsCol)) {
      const s = await q(
        `SELECT "${tsCol}" AS v, typeof("${tsCol}") AS t FROM "${t}"
         WHERE "${tsCol}" IS NOT NULL ORDER BY "${tsCol}" DESC LIMIT 1`,
      );
      console.log(`    ${tsCol}: sample=${JSON.stringify(s[0]?.v)} typeof=${s[0]?.t}`);
    }
  }
}

console.log("\n" + line + "\nDONE (read-only). Next: dry-run counts once schema confirmed.\n" + line);
await db.close?.();
