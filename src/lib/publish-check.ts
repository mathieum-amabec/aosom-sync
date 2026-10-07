import { ensureSchema } from "./database";
import { carriesMascot } from "./mascot-guard";

/**
 * Morning publish check (06:15 Montréal). The 06:00 Reel is the day's anchor post; this verifies
 * it — and every slot due in the last 3 hours — actually went out, and that nothing carrying the
 * mascot is still scheduled. Read-only: it never publishes, retries or edits a row.
 */
export interface CheckRow {
  id: number;
  contentId: string;
  status: string;
  scheduledAt: string;
  error: string | null;
}

export interface PublishCheckResult {
  ok: boolean;
  problems: string[];
  dueCount: number;
  publishedCount: number;
  checkedAt: string;
}

/** Statuses that, for a slot already due, mean "did not go out". Drafts/cancelled never publish. */
const NOT_OUT = new Set(["pending", "publishing", "failed"]);

export function evaluatePublishCheck(due: CheckRow[], mascotRows: CheckRow[], now: Date): PublishCheckResult {
  const problems: string[] = [];
  for (const r of due) {
    if (!NOT_OUT.has(r.status)) continue;
    const why = r.status === "failed" ? `échec: ${(r.error ?? "raison inconnue").slice(0, 160)}` : `toujours « ${r.status} »`;
    problems.push(`#${r.id} ${r.contentId} (créneau ${r.scheduledAt} UTC) — ${why}`);
  }
  for (const r of mascotRows) problems.push(`#${r.id} ${r.contentId} (${r.scheduledAt} UTC) — vidéo avec la mascotte encore planifiée`);
  return {
    ok: problems.length === 0,
    problems,
    dueCount: due.length,
    publishedCount: due.filter((r) => r.status === "published").length,
    checkedAt: now.toISOString(),
  };
}

function toRow(r: Record<string, unknown>): CheckRow {
  return { id: Number(r.id), contentId: String(r.content_id), status: String(r.status), scheduledAt: String(r.scheduled_at), error: (r.error as string) ?? null };
}

/** Slots due 5 min – 3 h ago (the publisher drains every 5 min) + any scheduled mascot row in the next 7 days. */
export async function runPublishCheck(now = new Date()): Promise<PublishCheckResult> {
  const db = await ensureSchema();
  const due = await db.execute(
    `SELECT id, content_id, status, scheduled_at, error FROM publication_queue
     WHERE status != 'cancelled' AND status != 'draft'
       AND scheduled_at <= datetime('now','-5 minutes') AND scheduled_at >= datetime('now','-3 hours')
     ORDER BY scheduled_at, id`,
  );
  const upcoming = await db.execute(
    `SELECT id, content_id, status, scheduled_at, error, metadata FROM publication_queue
     WHERE status IN ('pending','draft') AND metadata LIKE '%ameublo_studio%' AND scheduled_at >= datetime('now') AND scheduled_at <= datetime('now','+7 days')`,
  );
  const mascotRows = upcoming.rows
    .filter((r) => {
      try { return carriesMascot(JSON.parse(String(r.metadata))); } catch { return false; }
    })
    .filter((r) => r.status === "pending")
    .map((r) => toRow(r as unknown as Record<string, unknown>));
  return evaluatePublishCheck(due.rows.map((r) => toRow(r as unknown as Record<string, unknown>)), mascotRows, now);
}
