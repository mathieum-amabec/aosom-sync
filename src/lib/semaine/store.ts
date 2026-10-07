/**
 * `semaine_posts`: one row per (local day, slot). It makes the cron idempotent (a retry never
 * double-posts), remembers which products were used (cooldown), and is the history the
 * measurement step reads later. Created lazily so this feature adds no migration to database.ts.
 */
import { ensureSchema } from "@/lib/database";
import type { FormatId, RunStatus, SlotName } from "./types";

let ready: Promise<void> | null = null;

async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const db = await ensureSchema();
      await db.execute(`CREATE TABLE IF NOT EXISTS semaine_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_date TEXT NOT NULL,
        slot TEXT NOT NULL,
        format TEXT,
        skus TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        queue_ids TEXT,
        caption_fr TEXT,
        scheduled_at TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE (local_date, slot)
      )`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export interface PostRow {
  local_date: string;
  slot: SlotName;
  format: FormatId | null;
  status: RunStatus;
}

/** The existing row for a day+slot, if any. */
export async function getPost(localDate: string, slot: SlotName): Promise<PostRow | null> {
  await ensureTable();
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT local_date, slot, format, status FROM semaine_posts WHERE local_date = ? AND slot = ?`, args: [localDate, slot] });
  return r.rows[0] ? (r.rows[0] as unknown as PostRow) : null;
}

export async function savePost(p: {
  localDate: string;
  slot: SlotName;
  format?: FormatId;
  skus?: string[];
  status: RunStatus;
  reason?: string;
  queueIds?: number[];
  captionFr?: string;
  scheduledAt?: string;
}): Promise<void> {
  await ensureTable();
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO semaine_posts (local_date, slot, format, skus, status, reason, queue_ids, caption_fr, scheduled_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (local_date, slot) DO UPDATE SET
            format = excluded.format, skus = excluded.skus, status = excluded.status, reason = excluded.reason,
            queue_ids = excluded.queue_ids, caption_fr = excluded.caption_fr, scheduled_at = excluded.scheduled_at`,
    args: [
      p.localDate, p.slot, p.format ?? null, p.skus ? JSON.stringify(p.skus) : null, p.status, p.reason ?? null,
      p.queueIds ? JSON.stringify(p.queueIds) : null, p.captionFr ?? null, p.scheduledAt ?? null,
    ],
  });
}

/** SKUs used by a queued post within the last `days` days — the repost cooldown. */
export async function recentSkus(days: number): Promise<Set<string>> {
  await ensureTable();
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT skus FROM semaine_posts WHERE status = 'queued' AND created_at > cast(strftime('%s','now', ?) as integer)`,
    args: [`-${days} days`],
  });
  const out = new Set<string>();
  for (const row of r.rows) {
    try {
      for (const s of JSON.parse(String((row as unknown as { skus: string }).skus ?? "[]"))) out.add(String(s));
    } catch {
      /* ignore a malformed row */
    }
  }
  return out;
}

/** How many days in a row (ending now) a format ran as a fallback — for the daily report. */
export async function recentPosts(days: number): Promise<Array<{ local_date: string; slot: string; format: string | null; status: string; reason: string | null }>> {
  await ensureTable();
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT local_date, slot, format, status, reason FROM semaine_posts WHERE created_at > cast(strftime('%s','now', ?) as integer) ORDER BY local_date DESC, slot`,
    args: [`-${days} days`],
  });
  return r.rows as unknown as Array<{ local_date: string; slot: string; format: string | null; status: string; reason: string | null }>;
}
