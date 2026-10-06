/**
 * TikTok Content Posting API client — INBOX DRAFTS (`video.upload`). Raw REST, plain `fetch`, like the Pinterest client.
 *
 * What an inbox upload does: the video lands in the account owner's TikTok app as a DRAFT ("your video is ready to
 * edit"); the owner picks a sound, pastes the caption and taps Publish. It needs the `video.upload` scope but NOT
 * TikTok's audit (direct public posting, `video.publish`, does — and until it is passed everything posted directly is
 * private). Verified against TikTok's docs 2026-10.
 *
 * ⚠ A draft cannot carry a caption or title: TikTok's inbox endpoint takes none. `tiktokCaptionToPaste()` returns the text
 * the owner pastes.
 *
 * Flow: POST /v2/post/publish/inbox/video/init/ → PUT the bytes to the returned `upload_url` (one chunk when the video is
 * ≤ 64 MB: chunks are 5–64 MB, the last one may reach 128 MB) → poll POST /v2/post/publish/status/fetch/ until the draft
 * reaches the inbox. We upload the bytes ourselves (FILE_UPLOAD): PULL_FROM_URL needs a domain TikTok has verified, which
 * our Blob host is not.
 *
 * Dry-run: constructed with `dryRun: true` the client downloads and sends NOTHING; every call is recorded in `client.plan`.
 */

import { stripSupplierBrands } from "./catalog-guard";

export const TIKTOK_API_BASE = "https://open.tiktokapis.com";
const MB = 1024 * 1024;
export const TIKTOK_MIN_CHUNK_BYTES = 5 * MB;
export const TIKTOK_MAX_CHUNK_BYTES = 64 * MB;
/** Our own ceiling for one video (TikTok accepts far more; nothing we render comes close). */
export const TIKTOK_MAX_VIDEO_BYTES = 500 * MB;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export interface TikTokCredentials {
  accessToken: string;
}

export class TikTokApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly logId: string | null;
  constructor(path: string, status: number, body: unknown) {
    const e = ((body ?? {}) as { error?: { code?: string; message?: string; log_id?: string } }).error ?? {};
    super(`TikTok ${path} failed (HTTP ${status})` + (e.code && e.code !== "ok" ? `\n  • ${e.code}: ${e.message ?? ""}` : "") + (e.log_id ? `\n  • log_id ${e.log_id}` : ""));
    this.name = "TikTokApiError";
    this.status = status;
    this.code = e.code ?? null;
    this.logId = e.log_id ?? null;
  }
}

/** How TikTok wants a video of `size` bytes cut up: under 5 MB whole; up to 64 MB one chunk; beyond that 64 MB chunks, the last absorbing the rest. */
export function planChunks(size: number): { chunkSize: number; totalChunkCount: number } {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`TikTok upload: invalid video size ${size}`);
  if (size <= TIKTOK_MAX_CHUNK_BYTES) return { chunkSize: size, totalChunkCount: 1 };
  return { chunkSize: TIKTOK_MAX_CHUNK_BYTES, totalChunkCount: Math.floor(size / TIKTOK_MAX_CHUNK_BYTES) };
}

/** Inclusive byte ranges of each chunk (the last one runs to the end of the file). */
export function chunkRanges(size: number): { start: number; end: number }[] {
  const { chunkSize, totalChunkCount } = planChunks(size);
  return Array.from({ length: totalChunkCount }, (_, i) => ({ start: i * chunkSize, end: i === totalChunkCount - 1 ? size - 1 : (i + 1) * chunkSize - 1 }));
}

/** One recorded call, for dry-run rendering and post-run auditing. */
export interface PlannedCall {
  step: string;
  path: string;
  body: unknown;
}

export interface TikTokClientOptions {
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Poll the draft's status this often (default 3 s)… */
  pollIntervalMs?: number;
  /** …for at most this long (default 120 s). */
  maxWaitMs?: number;
}

const DONE = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]);

export class TikTokClient {
  readonly dryRun: boolean;
  readonly plan: PlannedCall[] = [];
  private readonly creds: TikTokCredentials | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;

  constructor(creds: TikTokCredentials | null, options: TikTokClientOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.creds = creds;
    if (!this.dryRun && !creds) throw new Error("TikTokClient: credentials are required unless dryRun is set.");
  }

  /** `GET /v2/user/info/` (scope `user.info.basic`): which account these tokens belong to. */
  async userInfo(): Promise<{ openId: string; displayName: string; username: string | null }> {
    const json = (await this.api("/v2/user/info/?fields=open_id,display_name,username", { method: "GET" })) as {
      data?: { user?: { open_id?: string; display_name?: string; username?: string } };
    };
    const u = json.data?.user ?? {};
    return { openId: u.open_id ?? "", displayName: u.display_name ?? "", username: u.username ?? null };
  }

  /**
   * Send one video to the account's TikTok inbox as a draft. Returns once TikTok reports the draft in the inbox.
   * Throws (and creates nothing visible) when TikTok rejects the upload or fails to process it.
   */
  async uploadDraft(videoUrl: string): Promise<{ publishId: string; status: string }> {
    if (this.dryRun) {
      this.plan.push({ step: "download", path: videoUrl, body: null });
      this.plan.push({ step: "init", path: "/v2/post/publish/inbox/video/init/", body: { source_info: { source: "FILE_UPLOAD", video_size: "<bytes>", chunk_size: "<bytes>", total_chunk_count: 1 } } });
      this.plan.push({ step: "upload", path: "(upload_url)", body: { method: "PUT", "Content-Range": "bytes 0-<size-1>/<size>" } });
      this.plan.push({ step: "status", path: "/v2/post/publish/status/fetch/", body: { publish_id: "dryrun-publish-1" } });
      return { publishId: "dryrun-publish-1", status: "SEND_TO_USER_INBOX" };
    }

    const src = await this.fetchImpl(videoUrl);
    if (!src.ok) throw new Error(`TikTok upload: cannot download ${videoUrl} (HTTP ${src.status})`);
    const buf = await src.arrayBuffer();
    if (buf.byteLength > TIKTOK_MAX_VIDEO_BYTES) throw new Error(`TikTok upload: ${(buf.byteLength / MB).toFixed(1)} MB exceeds our ${TIKTOK_MAX_VIDEO_BYTES / MB} MB ceiling`);
    const bytes = new Uint8Array(buf);

    const { chunkSize, totalChunkCount } = planChunks(bytes.byteLength);
    const initBody = { source_info: { source: "FILE_UPLOAD", video_size: bytes.byteLength, chunk_size: chunkSize, total_chunk_count: totalChunkCount } };
    const init = (await this.api("/v2/post/publish/inbox/video/init/", { method: "POST", body: initBody })) as { data?: { publish_id?: string; upload_url?: string } };
    const publishId = init.data?.publish_id;
    const uploadUrl = init.data?.upload_url;
    if (!publishId || !uploadUrl) throw new Error(`TikTok init returned an unexpected answer: ${JSON.stringify(init).slice(0, 200)}`);
    this.plan.push({ step: "init", path: "/v2/post/publish/inbox/video/init/", body: initBody });

    for (const { start, end } of chunkRanges(bytes.byteLength)) {
      const up = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}` },
        body: bytes.slice(start, end + 1),
      });
      if (!up.ok) throw new Error(`TikTok upload: storage answered HTTP ${up.status} for bytes ${start}-${end}`);
    }
    this.plan.push({ step: "upload", path: "(upload_url)", body: { bytes: bytes.byteLength, chunks: totalChunkCount } });

    const status = await this.awaitInbox(publishId);
    this.plan.push({ step: "status", path: "/v2/post/publish/status/fetch/", body: { publish_id: publishId, status } });
    return { publishId, status };
  }

  /** Poll the publish status until the draft is in the inbox (or TikTok failed it / we ran out of time). */
  private async awaitInbox(publishId: string): Promise<string> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const r = (await this.api("/v2/post/publish/status/fetch/", { method: "POST", body: { publish_id: publishId } })) as {
        data?: { status?: string; fail_reason?: string };
      };
      const status = r.data?.status ?? "";
      if (DONE.has(status)) return status;
      if (status === "FAILED") throw new Error(`TikTok could not process the video (publish ${publishId}: ${r.data?.fail_reason ?? "no reason given"})`);
      if (Date.now() + this.pollIntervalMs > deadline) {
        throw new Error(`TikTok draft still "${status || "unknown"}" after ${Math.round(this.maxWaitMs / 1000)}s (publish ${publishId})`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** JSON call with a bounded timeout and a retry on 429/5xx. TikTok reports failures as `error.code !== "ok"` even on HTTP 200. */
  private async api(path: string, o: { method: "GET" | "POST"; body?: unknown }, attempt = 0): Promise<unknown> {
    const creds = this.creds;
    if (!creds) throw new Error("TikTokClient: no credentials");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${TIKTOK_API_BASE}${path}`, {
        method: o.method,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${creds.accessToken}`, ...(o.method === "POST" ? { "Content-Type": "application/json; charset=UTF-8" } : {}) },
        ...(o.method === "POST" ? { body: JSON.stringify(o.body ?? {}) } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`TikTok request timeout after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await this.sleep(Math.min(retryAfter, 30) * 1000);
      return this.api(path, o, attempt + 1);
    }
    const json: unknown = await res.json().catch(() => ({}));
    const code = ((json ?? {}) as { error?: { code?: string } }).error?.code;
    if (!res.ok || (code && code !== "ok")) throw new TikTokApiError(path, res.status, json);
    return json;
  }
}

/**
 * The text the account owner pastes into the draft (TikTok drafts carry none): the caption with its links removed — TikTok
 * captions do not make links clickable — and supplier brands stripped.
 */
export function tiktokCaptionToPaste(caption: string): string {
  const out: string[] = [];
  for (const line of stripSupplierBrands(caption).split(/\r?\n/)) {
    if (!/https?:\/\//i.test(line)) {
      out.push(line); // blank lines are paragraph breaks
      continue;
    }
    const kept = line.replace(/\s*[:：]?\s*https?:\/\/\S+/gi, "").trim();
    if (kept) out.push(kept); // a line that held nothing but a link is dropped outright
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2200);
}
