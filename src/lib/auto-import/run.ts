/**
 * Automatic daily import — one cron tick.
 *
 * Runs every 5 minutes inside the UTC window (see vercel.json; 3 per tick = up to ~500/day, so a 300 cap fits). Each tick takes the next few
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
import { fetchOrderedProductUnits } from "@/lib/klaviyo-client";
import type { AosomMergedProduct } from "@/types/aosom";
import {
  DEFAULT_DAILY_CAP,
  DEMAND_DAYS,
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
/** Daily cache of the supplier demand map ({ day, units: { sku: n } }). */
export const DEMAND_KEY = "auto_import_demand";
/** Largest stock drop between two syncs still counted as sales (bigger = feed glitch or stock correction). */
const DEMAND_MAX_STEP = 60;
/** Daily cache of our own store's units sold per supplier product type ({ day, types: { type: n } }). */
export const STORE_SALES_KEY = "auto_import_store_sales";
/** Our order volume is still small: a year of orders gives the type signal something to stand on. */
const STORE_SALES_DAYS = 365;
/** A feed with fewer merged SKUs than this is treated as truncated (today's feed carries ~7,990). */
export const MIN_FEED_SKUS = 6000;
const LOCK_TTL_SECONDS = 280;
/**
 * Stop starting new products once this much of the function's 300 s is used: one product (copy, 3 checks, Shopify
 * create with images, storefront fetch) takes up to ~150 s, so starting one at 130 s still fits.
 */
const TICK_BUDGET_MS = 130_000;
/**
 * Pause for the rest of the day when this share of the day's processed products failed verification/errored.
 * Judged over a sample of 30: with ~10 products the rate swings too easily (6 published + 4 held = 40% paused the
 * run every day from 2026-10-09 to 2026-10-14).
 */
const PAUSE_FAILURE_RATE = 0.4;
const PAUSE_MIN_SAMPLE = 30;

/**
 * A product parked only because its supplier photos are unusable says nothing about the pipeline's health: it is
 * product-specific. It stays parked for review (counted in `photoHeld`) but does not feed the pause rule.
 * Infra failures (vision model down, unparseable answer, unreachable photos) are NOT matched here: they still pause.
 */
const PRODUCT_PHOTO_REASON = /^(gallery_too_few_clean_photos|no_clean_primary_photo)\b/;
export function isProductPhotoHold(r: Pick<ProcessResult, "outcome" | "layer" | "reasons">): boolean {
  return r.outcome === "needs_review" && r.layer === "gallery" && r.reasons.length > 0 && r.reasons.every((x) => PRODUCT_PHOTO_REASON.test(x));
}

export interface TickDeps {
  now(): Date;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  loadCatalog(): Promise<{ groups: AosomMergedProduct[]; skuCount: number; costs?: Map<string, number> }>;
  /** Cached competitor prices (SKU upper case), for the price the rule will give. Optional. */
  loadCompetitor?(): Promise<Map<string, number>>;
  /** SKU -> units that left the supplier's stock over DEMAND_DAYS. Optional; without it every demand is 0. */
  loadDemand?(day: string): Promise<Map<string, number>>;
  /** Supplier product type -> units our store sold of that type. Optional. */
  loadStoreTypeSales?(day: string): Promise<Map<string, number>>;
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
  /** Candidates left out by the import pricing rules (see policy.ts). */
  rejected?: { noCost: number; lowMargin: number; lowDemand?: number };
  state: DayState;
}

async function defaultLoadCatalog() {
  const raw = await fetchAosomCatalog();
  const costs = new Map<string, number>();
  for (const p of raw) if (typeof p.cost === "number" && p.cost > 0) costs.set(p.sku, p.cost);
  return { groups: mergeVariants(raw), skuCount: raw.length, costs };
}

export function defaultDeps(): TickDeps {
  return {
    now: () => new Date(),
    getSetting,
    setSetting,
    loadCatalog: defaultLoadCatalog,
    async loadCompetitor() {
      const db = await ensureSchema();
      const r = await db.execute(`SELECT sku, price FROM competitor_prices`);
      return new Map(r.rows.map((x) => [String(x.sku).toUpperCase(), Number(x.price)]));
    },
    async loadDemand(day) {
      // Computed once per local day and cached in settings: the stock history is ~60k rows, the cron ticks every 10 min.
      const cached = await getSetting(DEMAND_KEY);
      if (cached) {
        try {
          const c = JSON.parse(cached) as { day: string; units: Record<string, number> };
          if (c.day === day) return new Map(Object.entries(c.units));
        } catch {
          /* recompute */
        }
      }
      const db = await ensureSchema();
      const since = Math.floor(Date.now() / 1000) - DEMAND_DAYS * 86400;
      // A drop larger than DEMAND_MAX_STEP in one sync is a feed glitch or a stock correction, not sales.
      const r = await db.execute({
        sql: `SELECT sku, SUM(CASE WHEN old_qty > new_qty AND old_qty - new_qty <= ? THEN old_qty - new_qty ELSE 0 END) AS units
              FROM price_history WHERE change_type = 'stock_change' AND detected_at >= ? GROUP BY sku`,
        args: [DEMAND_MAX_STEP, since],
      });
      const units: Record<string, number> = {};
      for (const x of r.rows) if (Number(x.units) > 0) units[String(x.sku)] = Number(x.units);
      await setSetting(DEMAND_KEY, JSON.stringify({ day, units }));
      return new Map(Object.entries(units));
    },
    async loadStoreTypeSales(day) {
      // Our own sales come from Klaviyo "Ordered Product" events (the Shopify token has no read_orders), mapped to the
      // supplier product type through products.shopify_product_id. Once per local day, cached like the demand map.
      const cached = await getSetting(STORE_SALES_KEY);
      if (cached) {
        try {
          const c = JSON.parse(cached) as { day: string; types: Record<string, number> };
          if (c.day === day) return new Map(Object.entries(c.types));
        } catch {
          /* recompute */
        }
      }
      const byProduct = await fetchOrderedProductUnits(STORE_SALES_DAYS);
      const types: Record<string, number> = {};
      if (byProduct.size > 0) {
        const db = await ensureSchema();
        const r = await db.execute(
          `SELECT DISTINCT shopify_product_id, product_type FROM products WHERE shopify_product_id IS NOT NULL AND shopify_product_id != ''`,
        );
        const typeOf = new Map(r.rows.map((x) => [String(x.shopify_product_id), String(x.product_type ?? "")]));
        for (const [id, n] of byProduct) {
          const t = typeOf.get(id);
          if (t) types[t] = (types[t] ?? 0) + n;
        }
      }
      await setSetting(STORE_SALES_KEY, JSON.stringify({ day, types }));
      return new Map(Object.entries(types));
    },
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
    const { groups, skuCount, costs } = await d.loadCatalog();
    if (skuCount < MIN_FEED_SKUS) return { ...base, skipped: `feed-incomplete:${skuCount}` };

    const [importedSkus, firstSeen, jobs] = await Promise.all([d.loadImportedSkus(), d.loadFirstSeen(), d.loadJobs()]);
    const competitor = d.loadCompetitor ? await d.loadCompetitor().catch(() => undefined) : undefined;
    const demand = d.loadDemand ? await d.loadDemand(day).catch(() => undefined) : undefined;
    const storeTypeSales = d.loadStoreTypeSales ? await d.loadStoreTypeSales(day).catch(() => undefined) : undefined;
    const { candidates, flaggedLicensed, rejected } = buildCandidates(groups, {
      importedSkus, firstSeen, jobs, now, costs, competitor, demand, storeTypeSales,
    });
    const picked = pickBatch(candidates, state, n, dailyCap);
    const summary = picked.map((c) => ({ groupKey: c.groupKey, name: c.name.slice(0, 80), top: c.top, isNew: c.isNew }));
    const out: TickResult = { ...base, picked: summary, flaggedLicensed: flaggedLicensed.length, candidates: candidates.length, rejected };

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
      } else if (isProductPhotoHold(result)) state.photoHeld = (state.photoHeld ?? 0) + 1;
      else if (result.outcome === "needs_review") state.needsReview++;
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
