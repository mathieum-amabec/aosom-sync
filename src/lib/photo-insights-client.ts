/**
 * Photo-post measurement, the NETWORK half. READ-ONLY toward Meta, page token we already hold (no new permission).
 * Meta retires insight metrics without notice: a rejected metric never costs the snapshot, we keep whichever still exist and
 * only fail when NOTHING came back (expired token, deleted post…), with Meta's own message.
 */
import { FACEBOOK, META } from "./config";
import { facebookBrandCreds } from "./facebook-client";
import { instagramBrandCreds } from "./instagram-client";
import { EMPTY_PHOTO_METRICS, FB_PHOTO_METRICS, IG_PHOTO_METRICS, parseFacebookPhoto, parseInstagramPhoto, type PhotoMetrics } from "./photo-insights";

type Fetch = typeof fetch;
interface GraphError { code?: number; message?: string }

async function graph(f: Fetch, url: string, token: string): Promise<{ ok: boolean; json: unknown; error?: GraphError }> {
  const res = await f(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as { error?: GraphError };
  return { ok: res.ok && !json.error, json, error: json.error };
}

/** One call for all metrics; when Meta rejects one (code 100) ask for each separately and merge what exists. */
async function insights(f: Fetch, base: string, metrics: readonly string[], token: string): Promise<{ json: unknown; error?: string }> {
  const all = await graph(f, `${base}/insights?metric=${metrics.join(",")}`, token);
  if (all.ok) return { json: all.json };
  if (all.error?.code !== 100) return { json: { data: [] }, error: all.error?.message ?? "no answer" };
  const merged: unknown[] = [];
  let firstError = all.error?.message;
  for (const m of metrics) {
    const one = await graph(f, `${base}/insights?metric=${m}`, token);
    if (one.ok) merged.push(...(((one.json as { data?: unknown[] }).data) ?? []));
    else firstError ??= one.error?.message;
  }
  return { json: { data: merged }, error: merged.length ? undefined : firstError };
}

const hasAnything = (m: PhotoMetrics) => Object.values(m).some((v) => v != null);

export async function fetchFacebookPhotoInsights(postId: string, brand: "ameublo" | "furnish", opts: { fetchImpl?: Fetch } = {}): Promise<PhotoMetrics> {
  const f = opts.fetchImpl ?? fetch;
  const { token } = facebookBrandCreds(brand);
  const base = `${FACEBOOK.GRAPH_API_URL}/${postId}`;
  // The post's own counters never get retired; they carry the engagement even when the insight metrics are gone.
  const fields = await graph(f, `${base}?fields=reactions.summary(true).limit(0),comments.summary(true).limit(0),shares`, token);
  const ins = await insights(f, base, FB_PHOTO_METRICS, token);
  const m = parseFacebookPhoto(fields.ok ? fields.json : null, ins.json);
  if (!hasAnything(m)) throw new Error(`Facebook photo ${postId}: ${fields.error?.message ?? ins.error ?? "no metric available"}`);
  return { ...EMPTY_PHOTO_METRICS, ...m };
}

export async function fetchInstagramPhotoInsights(mediaId: string, brand: "ameublo" | "furnish", opts: { fetchImpl?: Fetch } = {}): Promise<PhotoMetrics> {
  const f = opts.fetchImpl ?? fetch;
  const { token } = instagramBrandCreds(brand);
  const ins = await insights(f, `${META.GRAPH_API_URL}/${mediaId}`, IG_PHOTO_METRICS, token);
  const m = parseInstagramPhoto(ins.json);
  if (!hasAnything(m)) throw new Error(`Instagram media ${mediaId}: ${ins.error ?? "no metric available"}`);
  return m;
}
