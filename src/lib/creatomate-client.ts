/**
 * Creatomate API client (https://creatomate.com) for automated product videos.
 *
 * Renders are ASYNCHRONOUS: `createVideoFromTemplate` kicks off a render and
 * returns its job id immediately; the MP4 url becomes available once
 * `getVideoStatus` reports `succeeded`. Callers either poll (see job4-social's
 * bounded wait) or resolve later.
 *
 * No-ops when CREATOMATE_API_KEY is unset (`createVideoFromTemplate` → null), so
 * the pipeline can call it unconditionally and simply skip video when not set up.
 */
import { env } from "./config";

const CREATOMATE_API = "https://api.creatomate.com/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export type RenderStatus = "planned" | "waiting" | "transcribing" | "rendering" | "succeeded" | "failed";

export interface VideoStatus {
  status: RenderStatus | "unknown";
  /** Public MP4 url — present once status is "succeeded". */
  url: string | null;
}

export function isCreatomateConfigured(): boolean {
  return !!env.creatomateApiKey;
}

function authHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Start a render from a template. Returns the render job id, or null when
 * Creatomate isn't configured / the API rejects the request (logged, non-throwing
 * so a video failure never breaks draft creation).
 *
 * `modifications` maps the template's element/variable names to values, e.g.
 * `{ product_image: url, product_title: name, price: "249.99 $", logo_url: url }`.
 */
export async function createVideoFromTemplate(
  templateId: string,
  modifications: Record<string, string>,
): Promise<string | null> {
  const key = env.creatomateApiKey;
  if (!key) return null;
  try {
    const res = await fetch(`${CREATOMATE_API}/renders`, {
      method: "POST",
      headers: authHeaders(key),
      body: JSON.stringify({ template_id: templateId, modifications }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[creatomate] createVideoFromTemplate ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    // POST /renders returns an array of render objects (one per output).
    const data = await res.json();
    const render = Array.isArray(data) ? data[0] : data;
    return render?.id ?? null;
  } catch (err) {
    console.warn(`[creatomate] createVideoFromTemplate failed: ${err}`);
    return null;
  }
}

/**
 * Start a vertical 9:16 (1080x1920) render for Instagram Reels, using the dedicated
 * CREATOMATE_REELS_TEMPLATE_ID (a separate template laid out for the portrait frame —
 * the square product template doesn't crop well to 9:16). Returns the render job id,
 * or null when the reels template isn't configured / Creatomate is off. Same async
 * model as createVideoFromTemplate.
 */
export function isReelsConfigured(): boolean {
  return !!env.creatomateApiKey && !!env.creatomateReelsTemplateId;
}

export async function createReelsVideo(
  modifications: Record<string, string>,
): Promise<string | null> {
  const templateId = env.creatomateReelsTemplateId;
  if (!templateId) return null; // no 9:16 template configured → caller skips the reel
  return createVideoFromTemplate(templateId, modifications);
}

/**
 * Start a 9:16 reels render and poll until it succeeds/fails or the budget runs out.
 * Returns the MP4 url or null (caller then skips the reel and posts the image instead).
 * No-ops to { jobId: null, url: null } when CREATOMATE_REELS_TEMPLATE_ID is unset.
 */
export async function renderReelsVideoAndWait(
  modifications: Record<string, string>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ jobId: string | null; url: string | null }> {
  const templateId = env.creatomateReelsTemplateId;
  if (!templateId) return { jobId: null, url: null };
  return renderVideoAndWait(templateId, modifications, opts);
}

/** Poll a render's status. Returns { status, url } — url is set once succeeded. */
export async function getVideoStatus(jobId: string): Promise<VideoStatus> {
  const key = env.creatomateApiKey;
  if (!key) return { status: "unknown", url: null };
  try {
    const res = await fetch(`${CREATOMATE_API}/renders/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { status: "unknown", url: null };
    const data = await res.json();
    return { status: (data?.status as RenderStatus) ?? "unknown", url: data?.url ?? null };
  } catch {
    return { status: "unknown", url: null };
  }
}

/**
 * Convenience: start a render and poll until it succeeds/fails or the budget runs
 * out. Returns the MP4 url, or null if it isn't ready in time (the caller proceeds
 * without a video — the image still posts). Bounded so it never hangs a job.
 */
export async function renderVideoAndWait(
  templateId: string,
  modifications: Record<string, string>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ jobId: string | null; url: string | null }> {
  const jobId = await createVideoFromTemplate(templateId, modifications);
  if (!jobId) return { jobId: null, url: null };

  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, url } = await getVideoStatus(jobId);
    if (status === "succeeded" && url) return { jobId, url };
    if (status === "failed") return { jobId, url: null };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { jobId, url: null }; // still rendering — caller proceeds without video
}
