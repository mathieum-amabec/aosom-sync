import { ensureSchema } from "./database";
import { carriesMascot } from "./mascot-guard";

/**
 * Morning publish check (06:15 Montréal). Read-only: it never publishes, retries or edits a row.
 *
 * It looks at EVERY publication_queue row due in the previous 24 h — all content types (social
 * photos, sequential_ad Reels, video, guides…), not only the 06:00 Reel — and flags:
 *   - `failed` rows;
 *   - rows stuck in `publishing` (claimed but never finished) for more than STUCK_AFTER_MIN;
 *   - rows still `pending` although their slot passed more than OVERDUE_AFTER_MIN ago
 *     (the publisher drains every 5 min);
 *   - `published` rows that carry an error: one platform went out, another did not (e.g. the
 *     Ameublo Instagram half of a post failed while Facebook went out). The known, expected
 *     noise "INSTAGRAM_FURNISH_ACCOUNT_ID not configured" on Furnish rows is ignored.
 * Plus any mascot Reel still scheduled in the next 7 days, and the Reels the price guard took out
 * of the queue (reel-price-guard.ts, setting `reel_price_guard_last`) since the last check.
 *
 * Before 2026-11-01 it only looked 5 min – 3 h back and counted `published` rows with an error as
 * fine, so five Ameublo Instagram failures (#1630 … #1682) went unnoticed.
 */
export interface CheckRow {
  id: number;
  contentId: string;
  status: string;
  scheduledAt: string;
  error: string | null;
  contentType?: string;
}

export interface PublishCheckResult {
  ok: boolean;
  problems: string[];
  dueCount: number;
  publishedCount: number;
  checkedAt: string;
  /** The operator paused automatic publications on purpose: nothing was checked, nothing is wrong. */
  paused?: boolean;
  /** Look-back window, in hours. */
  windowHours?: number;
  failedCount?: number;
  stuckCount?: number;
  overdueCount?: number;
  /** Published, but at least one platform failed (excluding the known Furnish-IG noise). */
  partialCount?: number;
  /** Due / published per content_type. */
  byType?: Record<string, { due: number; published: number }>;
  /** Reels blocked by the price guard since the previous check. */
  priceGuardBlocked?: number;
}

export const WINDOW_HOURS = 24;
export const STUCK_AFTER_MIN = 30;
export const OVERDUE_AFTER_MIN = 15;

/** Furnish has no Instagram account yet: every Furnish row "fails" its IG half by design. */
const KNOWN_NOISE = /INSTAGRAM_FURNISH_ACCOUNT_ID not configured/i;

/** The parts of a `published` row's error that are real failures ("platform: message | platform: message"). */
export function realErrorParts(error: string | null): string[] {
  if (!error) return [];
  return error
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !KNOWN_NOISE.test(s));
}

/** "2026-10-08 10:00:00" (SQLite UTC) → epoch ms. */
function utcMs(sqlite: string): number {
  return Date.parse(`${sqlite.replace(" ", "T")}Z`);
}

export interface PriceGuardEntry {
  id: number;
  contentId: string;
  scheduledAt: string;
  reason: string;
}

export function evaluatePublishCheck(
  due: CheckRow[],
  mascotRows: CheckRow[],
  now: Date,
  priceGuardBlocked: PriceGuardEntry[] = [],
): PublishCheckResult {
  const problems: string[] = [];
  const nowMs = now.getTime();
  const ageMin = (r: CheckRow) => (nowMs - utcMs(r.scheduledAt)) / 60_000;
  let failedCount = 0, stuckCount = 0, overdueCount = 0, partialCount = 0;
  const byType: Record<string, { due: number; published: number }> = {};
  const where = (r: CheckRow) => `#${r.id} ${r.contentType ? `${r.contentType} ` : ""}${r.contentId} (créneau ${r.scheduledAt} UTC)`;

  for (const r of due) {
    const t = (byType[r.contentType ?? "?"] ??= { due: 0, published: 0 });
    t.due++;
    if (r.status === "published") {
      t.published++;
      const parts = realErrorParts(r.error);
      if (parts.length > 0) {
        partialCount++;
        problems.push(`${where(r)} — publié en partie: ${parts.join(" | ").slice(0, 200)}`);
      }
    } else if (r.status === "failed") {
      failedCount++;
      problems.push(`${where(r)} — échec: ${(realErrorParts(r.error).join(" | ") || r.error || "raison inconnue").slice(0, 200)}`);
    } else if (r.status === "publishing" && ageMin(r) >= STUCK_AFTER_MIN) {
      stuckCount++;
      problems.push(`${where(r)} — bloqué « publishing » depuis ${Math.round(ageMin(r))} min`);
    } else if (r.status === "pending" && ageMin(r) >= OVERDUE_AFTER_MIN) {
      overdueCount++;
      problems.push(`${where(r)} — toujours « pending », en retard de ${Math.round(ageMin(r))} min`);
    }
  }
  for (const r of mascotRows) problems.push(`#${r.id} ${r.contentId} (${r.scheduledAt} UTC) — vidéo avec la mascotte encore planifiée`);
  for (const b of priceGuardBlocked) {
    problems.push(`#${b.id} ${b.contentId} (créneau ${b.scheduledAt} UTC) — retiré par la garde de prix: ${b.reason.slice(0, 200)}`);
  }
  return {
    ok: problems.length === 0,
    problems,
    dueCount: due.length,
    publishedCount: due.filter((r) => r.status === "published").length,
    checkedAt: now.toISOString(),
    windowHours: WINDOW_HOURS,
    failedCount,
    stuckCount,
    overdueCount,
    partialCount,
    byType,
    priceGuardBlocked: priceGuardBlocked.length,
  };
}

function toRow(r: Record<string, unknown>): CheckRow {
  return {
    id: Number(r.id),
    contentId: String(r.content_id),
    status: String(r.status),
    scheduledAt: String(r.scheduled_at),
    error: (r.error as string) ?? null,
    contentType: r.content_type == null ? undefined : String(r.content_type),
  };
}

/** Blocked Reels recorded by the price guard in the last WINDOW_HOURS (setting `reel_price_guard_last`). */
function recentPriceGuardBlocks(raw: string | null, now: Date): PriceGuardEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as { checkedAt?: string; blocked?: PriceGuardEntry[] };
    const at = v.checkedAt ? Date.parse(v.checkedAt) : NaN;
    if (!Number.isFinite(at) || now.getTime() - at > WINDOW_HOURS * 3_600_000) return [];
    return Array.isArray(v.blocked) ? v.blocked : [];
  } catch {
    return [];
  }
}

/** Every row due in the last 24 h (minus the last 5 min the publisher may still be draining) + scheduled mascot rows. */
export async function runPublishCheck(now = new Date()): Promise<PublishCheckResult> {
  const db = await ensureSchema();
  const due = await db.execute({
    sql: `SELECT id, content_type, content_id, status, scheduled_at, error FROM publication_queue
          WHERE status != 'cancelled' AND status != 'draft'
            AND scheduled_at <= datetime('now','-5 minutes') AND scheduled_at >= datetime('now', ?)
          ORDER BY scheduled_at, id`,
    args: [`-${WINDOW_HOURS} hours`],
  });
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
  const guard = await db.execute(`SELECT value FROM settings WHERE key = 'reel_price_guard_last'`);
  const guardRaw = guard.rows[0] ? String((guard.rows[0] as unknown as { value: string }).value) : null;
  return evaluatePublishCheck(
    due.rows.map((r) => toRow(r as unknown as Record<string, unknown>)),
    mascotRows,
    now,
    recentPriceGuardBlocks(guardRaw, now),
  );
}
