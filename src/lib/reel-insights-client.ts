/**
 * Reel measurement, the NETWORK half: read one Facebook Reel's insights from the Graph API (page token we already hold, no new
 * permission). Parsing and aggregation live in reel-insights.ts.
 */
import { FACEBOOK } from "./config";
import { facebookBrandCreds } from "./facebook-client";
import { parseReelInsights, REEL_METRICS, type ReelMetricName } from "./reel-insights";
import type { ReelMetrics } from "./database";

const EMPTY: ReelMetrics = { plays: null, initialPlays: null, avgWatchMs: null, totalWatchMs: null, socialActions: null };

/**
 * Read one Reel's insights. One call for all metrics; if Meta rejects one of them (it retires metrics without notice) we ask
 * for each separately and keep whichever still exist, rather than lose the whole snapshot. Throws only when NOTHING came back
 * (expired token, deleted video…), with Meta's own message.
 */
export async function fetchFacebookReelInsights(
  videoId: string,
  brand: "ameublo" | "furnish",
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ReelMetrics> {
  const f = opts.fetchImpl ?? fetch;
  const { token } = facebookBrandCreds(brand);
  const call = async (metrics: readonly ReelMetricName[]) => {
    const res = await f(`${FACEBOOK.GRAPH_API_URL}/${videoId}/video_insights?metric=${metrics.join(",")}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
    return { ok: res.ok && !json.error, json, error: json.error };
  };

  const all = await call(REEL_METRICS);
  if (all.ok) return parseReelInsights(all.json);
  if (all.error?.code !== 100) throw new Error(`Facebook insights ${videoId}: ${all.error?.message ?? "no answer"}`);

  const merged: unknown[] = [];
  let firstError = all.error?.message;
  for (const m of REEL_METRICS) {
    const one = await call([m]);
    if (one.ok) merged.push(...(((one.json as { data?: unknown[] }).data) ?? []));
    else firstError ??= one.error?.message;
  }
  if (!merged.length) throw new Error(`Facebook insights ${videoId}: ${firstError ?? "no metric available"}`);
  return { ...EMPTY, ...parseReelInsights({ data: merged }) };
}

