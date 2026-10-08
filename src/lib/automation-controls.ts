/**
 * Automation switches ("Automatisations" page): one place to stop — and to see the work of — the things that
 * run by themselves. Each switch is a plain `settings` row, so it takes effect on the very next cron tick,
 * with no deploy:
 *
 *   auto_import  `auto_import_mode` (off | dry | pilot | live). Turning it off remembers the previous mode in
 *                `auto_import_mode_resume` so "reprendre" brings it back as it was.
 *   publisher    `publisher_paused` = "1" → the publisher cron drains NOTHING: no automatic Facebook /
 *                Instagram / blog / guide publication leaves the queue (rows stay `pending`, nothing is lost).
 *   semaine      `semaine_enabled` (existing kill switch of "La semaine Ameublo"): "1" = queues photo posts.
 *
 * Pausing is always safe and reversible. Nothing here deletes or edits queued content.
 */
import { ensureSchema, getSetting, setSetting, getDailyLlmTokensUsed } from "@/lib/database";
import { poolBudget } from "@/lib/llm-budget";
import { parseMode, DEFAULT_DAILY_CAP, type AutoImportMode } from "@/lib/auto-import/policy";

export const IMPORT_MODE_KEY = "auto_import_mode";
export const IMPORT_RESUME_KEY = "auto_import_mode_resume";
export const IMPORT_CAP_KEY = "auto_import_daily_cap";
export const IMPORT_STATE_KEY = "auto_import_state";
export const PUBLISHER_PAUSED_KEY = "publisher_paused";
export const SEMAINE_KEY = "semaine_enabled";
export const LAST_CHANGE_KEY = "automation_last_change";

export type AutomationKey = "auto_import" | "publisher" | "semaine";
export const AUTOMATION_KEYS: readonly AutomationKey[] = ["auto_import", "publisher", "semaine"];

export async function isPublisherPaused(): Promise<boolean> {
  return (await getSetting(PUBLISHER_PAUSED_KEY)) === "1";
}

/** Mode to switch to for an on/off toggle of the import, plus the mode to remember for "resume". */
export function nextImportMode(
  current: AutoImportMode,
  enabled: boolean,
  resume: string | null,
  requested?: AutoImportMode,
): { mode: AutoImportMode; resume: AutoImportMode | null } {
  if (requested && requested !== "off") return { mode: requested, resume: requested };
  if (!enabled) return { mode: "off", resume: current !== "off" ? current : parseResume(resume) };
  const back = parseResume(resume);
  return { mode: back ?? "dry", resume: back };
}

function parseResume(raw: string | null): AutoImportMode | null {
  const m = parseMode(raw);
  return m === "off" ? null : m;
}

export async function setAutomation(
  key: AutomationKey,
  enabled: boolean,
  by: string,
  requestedMode?: AutoImportMode,
): Promise<void> {
  if (key === "auto_import") {
    const current = parseMode(await getSetting(IMPORT_MODE_KEY));
    const next = nextImportMode(current, enabled, await getSetting(IMPORT_RESUME_KEY), requestedMode);
    if (next.resume) await setSetting(IMPORT_RESUME_KEY, next.resume);
    await setSetting(IMPORT_MODE_KEY, next.mode);
  } else if (key === "publisher") {
    await setSetting(PUBLISHER_PAUSED_KEY, enabled ? "0" : "1");
  } else if (key === "semaine") {
    await setSetting(SEMAINE_KEY, enabled ? "1" : "0");
  }
  await setSetting(LAST_CHANGE_KEY, JSON.stringify({ key, enabled, by, at: new Date().toISOString() }));
}

export interface CronLine {
  name: string;
  status: string;
  detail: string | null;
  ranAt: number;
}

export interface AutomationStatus {
  generatedAt: string;
  lastChange: { key: string; enabled: boolean; by: string; at: string } | null;
  autoImport: {
    mode: AutoImportMode;
    on: boolean;
    resumeMode: AutoImportMode | null;
    dailyCap: number;
    today: { day: string; imported: number; toys: number; needsReview: number; failed: number } | null;
    last24h: { done: number; needsReview: number; error: number };
    recentProblems: Array<{ groupKey: string; status: string; reason: string; at: string }>;
    llm: { used: number; budget: number };
    lastRun: CronLine | null;
  };
  publisher: {
    paused: boolean;
    pending: number;
    overdue: number;
    next: string | null;
    failed3d: number;
    lastPublishedAt: string | null;
    lastRun: CronLine | null;
  };
  semaine: { on: boolean; pending: number; lastRun: CronLine | null };
}

function line(rows: Map<string, CronLine>, ...names: string[]): CronLine | null {
  let best: CronLine | null = null;
  for (const n of names) {
    const r = rows.get(n);
    if (r && (!best || r.ranAt > best.ranAt)) best = r;
  }
  return best;
}

function parseState(raw: string | null) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as { day?: string; total?: number; toys?: number; needsReview?: number; failed?: number };
    return { day: String(s.day ?? ""), imported: s.total ?? 0, toys: s.toys ?? 0, needsReview: s.needsReview ?? 0, failed: s.failed ?? 0 };
  } catch {
    return null;
  }
}

export async function getAutomationStatus(): Promise<AutomationStatus> {
  const db = await ensureSchema();
  const [modeRaw, resumeRaw, capRaw, stateRaw, pausedRaw, semaineRaw, changeRaw] = await Promise.all([
    getSetting(IMPORT_MODE_KEY),
    getSetting(IMPORT_RESUME_KEY),
    getSetting(IMPORT_CAP_KEY),
    getSetting(IMPORT_STATE_KEY),
    getSetting(PUBLISHER_PAUSED_KEY),
    getSetting(SEMAINE_KEY),
    getSetting(LAST_CHANGE_KEY),
  ]);

  const crons = await db.execute(
    `SELECT name, status, detail, MAX(ran_at) AS ran_at FROM cron_runs
     WHERE name IN ('auto-import','publisher','semaine','semaine-morning') GROUP BY name`,
  );
  const cronMap = new Map<string, CronLine>(
    crons.rows.map((r) => [
      String(r.name),
      { name: String(r.name), status: String(r.status), detail: (r.detail as string) ?? null, ranAt: Number(r.ran_at) || 0 },
    ]),
  );

  const [queue, failed, nextRow, lastPub, semainePending, jobs, problems] = await Promise.all([
    db.execute(`SELECT count(*) n, sum(scheduled_at <= datetime('now')) overdue FROM publication_queue WHERE status = 'pending'`),
    db.execute(`SELECT count(*) n FROM publication_queue WHERE status = 'failed' AND scheduled_at >= datetime('now','-3 days')`),
    db.execute(`SELECT min(scheduled_at) t FROM publication_queue WHERE status = 'pending' AND scheduled_at > datetime('now')`),
    db.execute(`SELECT max(published_at) t FROM publication_queue WHERE status = 'published'`),
    db.execute(`SELECT count(*) n FROM publication_queue WHERE status = 'pending' AND content_id LIKE 'semaine:%'`),
    db.execute(`SELECT status, count(*) n FROM import_jobs WHERE updated_at >= datetime('now','-1 day') GROUP BY status`),
    db.execute(
      `SELECT group_key, status, error, updated_at FROM import_jobs
       WHERE status IN ('needs_review','error') AND updated_at >= datetime('now','-1 day') ORDER BY updated_at DESC LIMIT 6`,
    ),
  ]);
  const jobCount = (s: string) => Number(jobs.rows.find((r) => r.status === s)?.n ?? 0);

  const mode = parseMode(modeRaw);
  const cap = Number(capRaw);
  const state = parseState(stateRaw);
  return {
    generatedAt: new Date().toISOString(),
    lastChange: changeRaw ? safeJson(changeRaw) : null,
    autoImport: {
      mode,
      on: mode !== "off",
      resumeMode: parseMode(resumeRaw) === "off" ? null : parseMode(resumeRaw),
      dailyCap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP,
      today: state,
      last24h: { done: jobCount("done"), needsReview: jobCount("needs_review"), error: jobCount("error") },
      recentProblems: problems.rows.map((r) => ({
        groupKey: String(r.group_key),
        status: String(r.status),
        reason: String(r.error ?? "").slice(0, 160),
        at: String(r.updated_at),
      })),
      llm: { used: await getDailyLlmTokensUsed("import"), budget: poolBudget("import") },
      lastRun: line(cronMap, "auto-import"),
    },
    publisher: {
      paused: pausedRaw === "1",
      pending: Number(queue.rows[0]?.n ?? 0),
      overdue: Number(queue.rows[0]?.overdue ?? 0),
      next: (nextRow.rows[0]?.t as string) ?? null,
      failed3d: Number(failed.rows[0]?.n ?? 0),
      lastPublishedAt: (lastPub.rows[0]?.t as string) ?? null,
      lastRun: line(cronMap, "publisher"),
    },
    semaine: { on: semaineRaw === "1", pending: Number(semainePending.rows[0]?.n ?? 0), lastRun: line(cronMap, "semaine-morning", "semaine") },
  };
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
