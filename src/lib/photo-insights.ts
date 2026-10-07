/**
 * Photo-post measurement, the PURE half: turn the Graph API answers into numbers, and the numbers into "which format works".
 * The network half is photo-insights-client.ts, the storage half photo-insights-store.ts.
 *
 * Meta retires insight metrics without notice, so every reader here tolerates a missing metric (it becomes null, never a crash)
 * and views/reach accept the current name AND the legacy one.
 */
import { LOW_SAMPLE, MATURE_HOURS } from "./reel-insights";

export interface PhotoMetrics {
  /** How many times the post was shown (impressions / media views). */
  views: number | null;
  /** How many different people saw it. */
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  /** Link / photo clicks (Facebook only). */
  clicks: number | null;
  /** Saves (Instagram only). */
  saves: number | null;
}

export const EMPTY_PHOTO_METRICS: PhotoMetrics = { views: null, reach: null, reactions: null, comments: null, shares: null, clicks: null, saves: null };

/** Facebook insight metrics to ask for, current names first, legacy ones as fallback. */
export const FB_PHOTO_METRICS = ["post_media_view", "post_total_media_view_unique", "post_impressions", "post_impressions_unique", "post_clicks"] as const;
/** Instagram media insight metrics. */
export const IG_PHOTO_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** `data: [{ name, values: [{ value }] }]` or `{ total_value: { value } }` → name → number. */
export function insightValues(json: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const data = (json as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const e = m as { name?: unknown; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } };
    if (typeof e.name !== "string") continue;
    const raw = e.values?.[e.values.length - 1]?.value ?? e.total_value?.value;
    const n = num(raw);
    if (n != null) out[e.name] = n;
  }
  return out;
}

/** Facebook: the post's own counters (always available) + its insights (best-effort). */
export function parseFacebookPhoto(fields: unknown, insights: unknown): PhotoMetrics {
  const f = (fields ?? {}) as {
    reactions?: { summary?: { total_count?: unknown } };
    comments?: { summary?: { total_count?: unknown } };
    shares?: { count?: unknown };
  };
  const v = insightValues(insights);
  return {
    views: v.post_media_view ?? v.post_impressions ?? null,
    reach: v.post_total_media_view_unique ?? v.post_impressions_unique ?? null,
    reactions: num(f.reactions?.summary?.total_count),
    comments: num(f.comments?.summary?.total_count),
    // A post nobody shared has no `shares` object at all: that is a real zero, not a missing number.
    shares: f.shares ? num(f.shares.count) : fields ? 0 : null,
    clicks: v.post_clicks ?? null,
    saves: null,
  };
}

export function parseInstagramPhoto(insights: unknown): PhotoMetrics {
  const v = insightValues(insights);
  return { views: v.views ?? null, reach: v.reach ?? null, reactions: v.likes ?? null, comments: v.comments ?? null, shares: v.shares ?? null, clicks: null, saves: v.saved ?? null };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface PhotoResultRow extends PhotoMetrics {
  queueId: number;
  /** semaine format id (nouveautes, baisses…), or "autre" for a photo that did not come from La semaine Ameublo. */
  format: string;
  publishedAt: string | null;
  /** Hours since it was published when the snapshot was read. */
  ageHours: number;
  measuredOn: string;
}

export interface PhotoGroupStat {
  key: string;
  n: number;
  avgViews: number;
  avgEngagement: number;
  lowSample: boolean;
}

export interface PhotoSummary {
  measured: number;
  matureCount: number;
  totalViews: number;
  totalReactions: number;
  totalComments: number;
  totalShares: number;
  byFormat: PhotoGroupStat[];
  lastMeasuredOn: string | null;
}

const sum = (xs: Array<number | null>) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const engagement = (r: PhotoMetrics) => (r.reactions ?? 0) + (r.comments ?? 0) + (r.shares ?? 0);
const viewsOf = (r: PhotoMetrics) => r.views ?? r.reach ?? 0;

/** Totals use every measured photo; format comparisons use ONLY photos old enough to have collected their numbers. */
export function summarizePhotos(rows: PhotoResultRow[]): PhotoSummary {
  const mature = rows.filter((r) => r.ageHours >= MATURE_HOURS);
  const groups = new Map<string, PhotoResultRow[]>();
  for (const r of mature) groups.set(r.format, [...(groups.get(r.format) ?? []), r]);
  const byFormat: PhotoGroupStat[] = [...groups].map(([key, g]) => ({
    key,
    n: g.length,
    avgViews: sum(g.map(viewsOf)) / g.length,
    avgEngagement: sum(g.map(engagement)) / g.length,
    lowSample: g.length < LOW_SAMPLE,
  }));
  byFormat.sort((a, b) => b.avgViews - a.avgViews);
  return {
    measured: rows.length,
    matureCount: mature.length,
    totalViews: sum(rows.map(viewsOf)),
    totalReactions: sum(rows.map((r) => r.reactions)),
    totalComments: sum(rows.map((r) => r.comments)),
    totalShares: sum(rows.map((r) => r.shares)),
    byFormat,
    lastMeasuredOn: rows.reduce<string | null>((m, r) => (!m || r.measuredOn > m ? r.measuredOn : m), null),
  };
}

export const FORMAT_LABEL: Record<string, string> = {
  nouveautes: "Nouveautés de la semaine",
  baisses: "Prix en baisse",
  piece: "La pièce complète",
  ab: "A ou B?",
  "top-ventes": "Les plus populaires",
  astuce: "Astuce déco",
  coeur: "Coup de cœur",
  vedette: "Produit vedette",
  autre: "Autres photos",
};

export const formatLabelOf = (key: string): string => FORMAT_LABEL[key] ?? key;
