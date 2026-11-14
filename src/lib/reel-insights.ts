/**
 * Reel measurement, the PURE half: parse a Graph `video_insights` answer, and turn a pile of measured Reels into the few
 * tables that answer "what works": by kind of video, by language, by time slot. The network half is reel-insights-client.ts
 * (kept apart so the morning report and the Studio can import this without pulling in the Facebook client).
 *
 * Facebook only for now. Verified against the live Graph API (2026-10-06, page token we already hold, no new permission):
 *   fb_reels_total_plays          plays, replays included
 *   blue_reels_play_count         initial plays
 *   post_video_avg_time_watched   milliseconds
 *   post_video_view_time          total milliseconds watched
 *   post_video_social_actions     {LIKE: n, COMMENT: n, SHARE: n}  (an empty object when none)
 * `post_impressions_unique` is NOT valid on a Reel video (HTTP 400, code 100): never ask for it.
 *
 * Numbers are tiny for now (a Reel published hours ago had 3 plays), so every group carries its sample size and is flagged
 * `lowSample` under LOW_SAMPLE reels: a table of 2-reel averages must not look like a finding.
 */
import type { ReelMetrics, ReelResultRow } from "./database";

export const LOW_SAMPLE = 5;
export const REEL_METRICS = ["fb_reels_total_plays", "blue_reels_play_count", "post_video_avg_time_watched", "post_video_view_time", "post_video_social_actions"] as const;
export type ReelMetricName = (typeof REEL_METRICS)[number];

export interface InsightEntry {
  name?: string;
  values?: { value?: unknown }[];
}

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Sum of an object's numeric values (post_video_social_actions), or the number itself. */
const total = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).reduce<number>((s, x) => s + (typeof x === "number" ? x : 0), 0);
  return null;
};

/** Turn a Graph `video_insights` answer (`{data: [...]}`) into our metrics; any metric the answer lacks stays null. */
export function parseReelInsights(json: unknown): ReelMetrics {
  const data = ((json ?? {}) as { data?: InsightEntry[] }).data ?? [];
  const by = new Map<string, unknown>();
  for (const e of data) if (e.name) by.set(e.name, e.values?.[0]?.value);
  return {
    plays: asNumber(by.get("fb_reels_total_plays")),
    initialPlays: asNumber(by.get("blue_reels_play_count")),
    avgWatchMs: asNumber(by.get("post_video_avg_time_watched")),
    totalWatchMs: asNumber(by.get("post_video_view_time")),
    socialActions: total(by.get("post_video_social_actions")),
  };
}

// ── aggregation ────────────────────────────────────────────────────────────────

export interface GroupStat {
  key: string;
  /** Reels measured in this group. */
  n: number;
  totalPlays: number;
  avgPlays: number;
  medianPlays: number;
  /** Average seconds watched per play (mean of the Reels' own averages), null when none reported. */
  avgWatchS: number | null;
  lowSample: boolean;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function group(key: string, rows: ReelResultRow[]): GroupStat {
  const plays = rows.map((r) => r.plays ?? 0);
  const watch = rows.map((r) => r.avgWatchMs).filter((x): x is number => x != null && x > 0);
  return {
    key,
    n: rows.length,
    totalPlays: plays.reduce((a, b) => a + b, 0),
    avgPlays: plays.length ? plays.reduce((a, b) => a + b, 0) / plays.length : 0,
    medianPlays: median(plays),
    avgWatchS: watch.length ? watch.reduce((a, b) => a + b, 0) / watch.length / 1000 : null,
    lowSample: rows.length < LOW_SAMPLE,
  };
}

const bucket = (rows: ReelResultRow[], keyOf: (r: ReelResultRow) => string): GroupStat[] => {
  const m = new Map<string, ReelResultRow[]>();
  for (const r of rows) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]);
  return [...m.entries()].map(([k, v]) => group(k, v)).sort((a, b) => b.avgPlays - a.avgPlays);
};

/** The grid slot a Reel went out in (Toronto time): "06:00" "07:45" "12:15" "19:45" (EN is +5 min), else the hour. */
export function slotOf(scheduledAtUtc: string): string {
  const d = new Date(`${scheduledAtUtc.replace(" ", "T")}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const near = (hh: number, mm: number) => Math.abs(mins - (hh * 60 + mm)) <= 10;
  if (near(6, 0)) return "06:00";
  if (near(7, 45)) return "07:45";
  if (near(12, 15)) return "12:15";
  if (near(19, 45)) return "19:45";
  return `${parts.hour}h`;
};

/** A Reel younger than this has not collected what an older one has: it is kept out of every comparison (not out of the totals). */
export const MATURE_HOURS = 48;

export interface ReelSummary {
  /** Reels measured at all. */
  measured: number;
  /** Of those, how many are old enough (MATURE_HOURS) to be compared fairly; the tables below use ONLY these. */
  matureCount: number;
  totalPlays: number;
  byStyle: GroupStat[];
  byLang: GroupStat[];
  bySlot: GroupStat[];
  /** Best and worst individual (mature) Reels by plays (needs a few to mean anything). */
  top: ReelResultRow[];
  bottom: ReelResultRow[];
  /** Most recent measurement date (UTC), null when nothing was measured yet. */
  lastMeasuredOn: string | null;
}

export function summarizeReels(rows: ReelResultRow[]): ReelSummary {
  const mature = rows.filter((r) => r.ageHours >= MATURE_HOURS);
  const byPlays = [...mature].sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0));
  return {
    measured: rows.length,
    matureCount: mature.length,
    totalPlays: rows.reduce((s, r) => s + (r.plays ?? 0), 0),
    byStyle: bucket(mature, (r) => r.style),
    byLang: bucket(mature, (r) => r.lang),
    bySlot: bucket(mature, (r) => slotOf(r.scheduledAt)).sort((a, b) => a.key.localeCompare(b.key)),
    top: byPlays.slice(0, 5),
    bottom: mature.length > 5 ? byPlays.slice(-5).reverse() : [],
    lastMeasuredOn: rows.reduce<string | null>((m, r) => (!m || r.measuredOn > m ? r.measuredOn : m), null),
  };
}
