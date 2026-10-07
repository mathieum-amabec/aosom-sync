/**
 * Photo-post measurement, the STORAGE half. One snapshot per (queue row, platform, UTC day), upserted by
 * /api/cron/photo-insights. The table is created lazily so this feature adds nothing to database.ts's schema block.
 * Reuses `queue_post_ids` (written by the publisher for every published item) to know which Facebook / Instagram post a queue row became.
 */
import { ensureSchema } from "./database";
import { EMPTY_PHOTO_METRICS, type PhotoMetrics, type PhotoResultRow } from "./photo-insights";

let ready: Promise<void> | null = null;

async function ensureTable(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const db = await ensureSchema();
      await db.execute(`CREATE TABLE IF NOT EXISTS photo_insights (
        queue_id INTEGER NOT NULL, platform TEXT NOT NULL, post_id TEXT NOT NULL, day TEXT NOT NULL,
        views INTEGER, reach INTEGER, reactions INTEGER, comments INTEGER, shares INTEGER, clicks INTEGER, saves INTEGER,
        collected_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (queue_id, platform, day)
      )`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export interface PhotoToMeasure {
  queueId: number;
  brand: "ameublo" | "furnish";
  fbPostId: string | null;
  igPostId: string | null;
}

/** Published photo posts of the last `days` days whose post ids we recorded. Newest first (their numbers move the most). */
export async function listPhotosToMeasure(days: number): Promise<PhotoToMeasure[]> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT q.id, q.payload, p.fb_post_id, p.ig_post_id
            FROM publication_queue q JOIN queue_post_ids p ON p.queue_id = q.id
           WHERE q.status = 'published' AND q.content_type = 'social' AND (p.fb_post_id IS NOT NULL OR p.ig_post_id IS NOT NULL)
             AND q.published_at >= datetime('now', ?)
           ORDER BY q.published_at DESC`,
    args: [`-${Math.max(1, Math.floor(days))} days`],
  });
  const out: PhotoToMeasure[] = [];
  for (const row of r.rows) {
    const o = row as unknown as Record<string, unknown>;
    let brand: string | undefined;
    try {
      brand = (JSON.parse(String(o.payload)) as { brand?: string }).brand;
    } catch {
      /* unreadable payload: skipped below */
    }
    if (brand !== "ameublo" && brand !== "furnish") continue;
    out.push({ queueId: Number(o.id), brand, fbPostId: o.fb_post_id ? String(o.fb_post_id) : null, igPostId: o.ig_post_id ? String(o.ig_post_id) : null });
  }
  return out;
}

export async function savePhotoInsight(queueId: number, platform: "facebook" | "instagram", postId: string, m: PhotoMetrics): Promise<void> {
  await ensureTable();
  const db = await ensureSchema();
  await db.execute({
    sql: `INSERT INTO photo_insights (queue_id, platform, post_id, day, views, reach, reactions, comments, shares, clicks, saves)
          VALUES (?, ?, ?, date('now'), ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(queue_id, platform, day) DO UPDATE SET
            post_id = excluded.post_id, views = excluded.views, reach = excluded.reach, reactions = excluded.reactions,
            comments = excluded.comments, shares = excluded.shares, clicks = excluded.clicks, saves = excluded.saves,
            collected_at = datetime('now')`,
    args: [queueId, platform, postId, m.views, m.reach, m.reactions, m.comments, m.shares, m.clicks, m.saves],
  });
}

/** Latest Facebook snapshot of every photo published in the last `days` days (Facebook = both brands' pages, so formats compare fairly). */
export async function getPhotoResultRows(days: number): Promise<PhotoResultRow[]> {
  await ensureTable();
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT q.id, q.metadata, q.published_at, i.day, i.views, i.reach, i.reactions, i.comments, i.shares, i.clicks, i.saves,
                 (julianday(i.collected_at) - julianday(q.published_at)) * 24 AS age_hours
            FROM publication_queue q
            JOIN photo_insights i ON i.queue_id = q.id AND i.platform = 'facebook'
             AND i.day = (SELECT MAX(day) FROM photo_insights WHERE queue_id = q.id AND platform = 'facebook')
           WHERE q.status = 'published' AND q.content_type = 'social' AND q.published_at >= datetime('now', ?)`,
    args: [`-${Math.max(1, Math.floor(days))} days`],
  });
  return r.rows.map((row) => {
    const o = row as unknown as Record<string, unknown>;
    let format = "autre";
    try {
      const f = (JSON.parse(String(o.metadata ?? "{}")) as { source?: string; format?: string });
      if (f.source === "semaine" && f.format) format = f.format;
    } catch {
      /* no metadata: an older photo */
    }
    const n = (v: unknown) => (v == null ? null : Number(v));
    return {
      ...EMPTY_PHOTO_METRICS,
      queueId: Number(o.id),
      format,
      publishedAt: o.published_at ? String(o.published_at) : null,
      ageHours: Number(o.age_hours ?? 0),
      measuredOn: String(o.day),
      views: n(o.views), reach: n(o.reach), reactions: n(o.reactions), comments: n(o.comments), shares: n(o.shares), clicks: n(o.clicks), saves: n(o.saves),
    };
  });
}

/** Instagram views of the same window (the carousel/photo posts of the Ameublo account), for one line in the report. */
export async function getInstagramViews(days: number): Promise<number | null> {
  await ensureTable();
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT SUM(i.views) AS v FROM photo_insights i
            JOIN publication_queue q ON q.id = i.queue_id
           WHERE i.platform = 'instagram' AND q.published_at >= datetime('now', ?)
             AND i.day = (SELECT MAX(day) FROM photo_insights WHERE queue_id = i.queue_id AND platform = 'instagram')`,
    args: [`-${Math.max(1, Math.floor(days))} days`],
  });
  const v = (r.rows[0] as unknown as { v: unknown } | undefined)?.v;
  return v == null ? null : Number(v);
}
