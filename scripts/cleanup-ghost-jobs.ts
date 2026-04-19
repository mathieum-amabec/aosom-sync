/**
 * cleanup-ghost-jobs.ts
 *
 * Recovers import_jobs stuck in "importing" status due to process timeouts.
 * A ghost job is one that has been in "importing" for more than 1 hour —
 * the worker that started it is long gone and the job will never self-resolve.
 *
 * Usage:
 *   bun run scripts/cleanup-ghost-jobs.ts           # dry-run (no writes)
 *   bun run scripts/cleanup-ghost-jobs.ts --apply   # apply recovery
 */

import { initSchema } from "@/lib/database";
import { createClient } from "@libsql/client";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load .env.local for local/dev runs
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// ─── Logger ──────────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  const entry = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...(data ?? {}),
  };
  console.log(JSON.stringify(entry));
}

// ─── DB Connection ────────────────────────────────────────────────────────────

function getClient() {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (tursoUrl && tursoToken) {
    return createClient({ url: tursoUrl, authToken: tursoToken });
  }
  if (tursoUrl || tursoToken) {
    throw new Error("Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set (or neither for local SQLite)");
  }
  const dbDir = path.join(process.cwd(), "data");
  return createClient({ url: `file:${path.join(dbDir, "aosom-sync.db")}` });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface GhostJob {
  id: string;
  group_key: string;
  updated_at: string;
  age_minutes: number;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const GHOST_THRESHOLD_MINUTES = 60;
const RECOVERY_ERROR = "Ghost job from timeout — auto-recovered by cleanup-ghost-jobs";

async function run() {
  const applyMode = process.argv.includes("--apply");

  log("info", "cleanup-ghost-jobs starting", { mode: applyMode ? "apply" : "dry-run", threshold_minutes: GHOST_THRESHOLD_MINUTES });

  await initSchema();
  const db = getClient();

  // Find ghost jobs: stuck in "importing" for more than GHOST_THRESHOLD_MINUTES
  const result = await db.execute({
    sql: `
      SELECT
        id,
        group_key,
        updated_at,
        CAST(
          (strftime('%s', 'now') - strftime('%s', updated_at)) / 60 AS INTEGER
        ) AS age_minutes
      FROM import_jobs
      WHERE status = 'importing'
        AND (strftime('%s', 'now') - strftime('%s', updated_at)) > :threshold_seconds
      ORDER BY updated_at ASC
    `,
    args: { threshold_seconds: GHOST_THRESHOLD_MINUTES * 60 },
  });

  const ghosts: GhostJob[] = result.rows.map((row) => ({
    id: String(row.id),
    group_key: String(row.group_key),
    updated_at: String(row.updated_at),
    age_minutes: Number(row.age_minutes),
  }));

  log("info", "ghost jobs found", { count: ghosts.length, jobs: ghosts });

  if (ghosts.length === 0) {
    console.log(JSON.stringify({ success: true, data: { recovered: 0, jobs: [] } }));
    return;
  }

  if (!applyMode) {
    log("info", "dry-run complete — rerun with --apply to recover");
    console.log(JSON.stringify({ success: true, data: { mode: "dry-run", would_recover: ghosts.length, jobs: ghosts } }));
    return;
  }

  // Apply: mark each ghost job as failed (idempotent — WHERE status='importing' prevents double-apply)
  const now = new Date().toISOString();
  let recovered = 0;

  for (const job of ghosts) {
    await db.execute({
      sql: `
        UPDATE import_jobs
        SET status = 'failed', error = :error, updated_at = :now
        WHERE id = :id AND status = 'importing'
      `,
      args: { id: job.id, error: RECOVERY_ERROR, now },
    });
    recovered++;
    log("info", "recovered ghost job", { id: job.id, group_key: job.group_key, age_minutes: job.age_minutes });
  }

  log("info", "cleanup-ghost-jobs complete", { recovered });
  console.log(JSON.stringify({ success: true, data: { mode: "apply", recovered, jobs: ghosts } }));
}

run().catch((err) => {
  log("error", "cleanup-ghost-jobs failed", { error: String(err) });
  console.log(JSON.stringify({ success: false, error: String(err) }));
  process.exit(1);
});
