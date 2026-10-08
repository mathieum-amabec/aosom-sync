/**
 * Automatic daily import — one cron tick.
 *
 * Runs every 10 minutes inside the UTC window (see vercel.json). Each tick takes the next few
 * candidates the day's pace allows, so ~100 imports/day are spread across the window and a tick
 * always fits in its time budget. Everything is idempotent: the day's counters live in
 * `settings.auto_import_state`, a group with a job is never re-picked, and a lock keeps two ticks
 * from overlapping.
 *
 * Modes (`settings.auto_import_mode`): off (default) | dry (select + record the plan, write nothing)
 * | pilot (drafts only, small batch for the owner to review) | live (verify, then activate).
 */
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { mergeVariants } from "@/lib/variant-merger";
import { ensureSchema, getSetting, setSetting } from "@/lib/database";
import { localClock } from "@/lib/morning-report";
import { LlmBudgetExceededError } from "@/lib/llm-budget";
import type { AosomMergedProduct } from "@/types/aosom";
import {
  DEFAULT_DAILY_CAP,
  PILOT_DAILY_CAP,
  MAX_PER_TICK,
  allowedSoFar,
  buildCandidates,
  emptyState,
  parseMode,
  pickBatch,
  type AutoImportMode,
  type Candidate,
  type DayState,
} from "./policy";
import { processCandidate, type ProcessResult } from "./process-one";

export const MODE_KEY = "auto_import_mode";
export const CAP_KEY = "auto_import_daily_cap";
export const STATE_KEY = "auto_import_state";
export const PLAN_KEY = "auto_import_last_plan";
export const LOCK_KEY = "auto_import_lock";
/** A feed with fewer merged SKUs than this is treated as truncated (today's feed carries ~7,990). */
export const MIN_FEED_SKUS = 6000;
const LOCK_TTL_SECONDS = 280;
/**
 * Stop starting new products once this much of the function's 300 s is used: one product (copy, 3 checks, Shopify
 * create with images, storefront fetch) takes up to ~150 s, so starting one at 130 s still fits.
 */
const TICK_BUDGET_MS = 130_000;
/** Pause for the rest of the day when this share of the day's processed products failed verification/errored. */
const PAUSE_FAILURE_RATE = 0.4;
const PAUSE_MIN_SAMPLE = 10;

export interface TickDeps {
  now(): Date;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  loadCatalog(): Promise<{ groups: AosomMergedProduct[]; skuCount: number }>;
  loadImportedSkus(): Promise<Set<string>>;
  loadFirstSeen(): Promise<Map<string, number>>;
  loadJobs(): Promise<Map<string, { status: string; updatedAt: string }>>;
  acquireLock(ttlSeconds: number): Promise<boolean>;
  releaseLock(): Promise<void>;
  process(c: Candidate, mode: Exclude<AutoImportMode, "off" | "dry">): Promise<ProcessResult>;
}

export interface TickResult {
  mode: AutoImportMode;
  day: string;
  skipped?: string;
  picked: Array<{ groupKey: string; name: string; top: string; isNew: boolean }>;
  results: ProcessResult[];
  flaggedLicensed: number;
  candidates: number;
  state: DayState;
}

async function defaultLoadCatalog() {
  const raw = await fetchAosomCatalog();
  return { groups: mergeVariants(raw), skuCount: raw.length };
}

export function defaultDeps(): TickDeps {
  return {
    now: () => new Date(),
    getSetting,
    setSetting,
    loadCatalog: defaultLoadCatalog,
    async loadImportedSkus() {
      const db = await ensureSchema();
      const r = await db.execute(`SELECT sku FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`);
      return new Set(r.rows.map((x) => String(x.sku)));
    },
    async loadFirstSeen() {
      const db = await ensureSchema();
      const r = await db.execute(`SELECT sku, created_at FROM products`);
      return new Map(r.rows.map((x) => [String(x.sku), Number(x.created_at)]));
    },
    async loadJobs() {
      const db = await ensureSchema();
      const r = await db.execute(`SELECT group_key, status, updated_at FROM import_jobs`);
      return new Map(r.rows.map((x) => [String(x.group_key), { status: String(x.status), updatedAt: String(x.updated_at) }]));
    },
    async acquireLock(ttl) {
      const db = await ensureSchema();
      const nowS = Math.floor(Date.now() / 1000);
      const r = await db.execute({
        sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, 'locked', ?)
              ON CONFLICT(key) DO UPDATE SET value = 'locked', updated_at = excluded.updated_at
              WHERE settings.updated_at < ?`,
        args: [LOCK_KEY, nowS, nowS - ttl],
      });
      return r.rowsAffected > 0;
    },
    async releaseLock() {
      const db = await ensureSchema();
      await db.execute({ sql: `UPDATE settings SET updated_at = 0 WHERE key = ?`, args: [LOCK_KEY] });
    },
    process: processCandidate,
  };
}

function parseState(raw: string | null, day: string): DayState {
  if (!raw) return emptyState(day);
  try {
    const s = JSON.parse(raw) as DayState;
    return s.day === day ? { ...emptyState(day), ...s } : emptyState(day);
  } catch {
    return emptyState(day);
  }
}

function shouldPause(s: DayState): boolean {
  const processed = s.total + s.needsReview + s.failed;
  return processed >= PAUSE_MIN_SAMPLE && (s.needsReview + s.failed) / processed >= PAUSE_FAILURE_RATE;
}

export async function runAutoImportTick(opts: { force?: boolean; deps?: TickDeps } = {}): Promise<TickResult> {
  const d = opts.deps ?? defaultDeps();
  const now = d.now();
  const day = localClock(now).date;
  const mode = parseMode(await d.getSetting(MODE_KEY));
  const state = parseState(await d.getSetting(STATE_KEY), day);
  const base: TickResult = { mode, day, picked: [], results: [], flaggedLicensed: 0, candidates: 0, state };
  if (mode === "off") return { ...base, skipped: "off" };

  const capSetting = Number(await d.getSetting(CAP_KEY));
  const dailyCap = mode === "pilot" ? PILOT_DAILY_CAP : Number.isFinite(capSetting) && capSetting > 0 ? capSetting : DEFAULT_DAILY_CAP;
  if (state.total >= dailyCap) return { ...base, skipped: "cap-reached" };
  if (shouldPause(state)) return { ...base, skipped: "paused-high-failure-rate" };

  const allowed = opts.force ? dailyCap : allowedSoFar(now, dailyCap);
  const n = Math.min(MAX_PER_TICK, allowed - state.total);
  if (n <= 0) return { ...base, skipped: "pace" };

  if (!(await d.acquireLock(LOCK_TTL_SECONDS))) return { ...base, skipped: "locked" };
  const started = Date.now();
  try {
    const { groups, skuCount } = await d.loadCatalog();
    if (skuCount < MIN_FEED_SKUS) return { ...base, skipped: `feed-incomplete:${skuCount}` };

    const [importedSkus, firstSeen, jobs] = await Promise.all([d.loadImportedSkus(), d.loadFirstSeen(), d.loadJobs()]);
    const { candidates, flaggedLicensed } = buildCandidates(groups, { importedSkus, firstSeen, jobs, now });
    const picked = pickBatch(candidates, state, n, dailyCap);
    const summary = picked.map((c) => ({ groupKey: c.groupKey, name: c.name.slice(0, 80), top: c.top, isNew: c.isNew }));
    const out: TickResult = { ...base, picked: summary, flaggedLicensed: flaggedLicensed.length, candidates: candidates.length };

    if (mode === "dry") {
      await d.setSetting(PLAN_KEY, JSON.stringify({ at: now.toISOString(), eligible: candidates.length, flaggedLicensed: flaggedLicensed.length, next: summary }));
      return { ...out, skipped: "dry-run" };
    }

    for (const c of picked) {
      if (Date.now() - started > TICK_BUDGET_MS) break;
      let result: ProcessResult;
      try {
        result = await d.process(c, mode);
      } catch (err) {
        if (err instanceof LlmBudgetExceededError) {
          out.skipped = "llm-budget-exhausted";
          break;
        }
        result = { outcome: "error", groupKey: c.groupKey, reasons: [err instanceof Error ? err.message.slice(0, 200) : "error"] };
      }
      out.results.push(result);
      if (result.outcome === "live" || result.outcome === "pilot_draft") {
        state.total++;
        state.byCat[c.top] = (state.byCat[c.top] ?? 0) + 1;
        if (c.top === "Toys & Games") state.toys++;
        if (c.isNew) state.newCount++;
      } else if (result.outcome === "needs_review") state.needsReview++;
      else if (result.outcome === "error") state.failed++;
      await d.setSetting(STATE_KEY, JSON.stringify(state));
      if (shouldPause(state)) {
        out.skipped = "paused-high-failure-rate";
        break;
      }
    }
    return { ...out, state };
  } finally {
    await d.releaseLock().catch(() => {});
  }
}
