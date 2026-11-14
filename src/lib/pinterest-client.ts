/**
 * Pinterest API v5 client — raw REST, mirroring the plain-`fetch` posture of
 * meta-ads-client.ts and google-ads-client.ts and keeping the dependency tree flat.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────────────────
 * OAuth2 Bearer token. Pinterest exposes ONE API (v5); the "Ads" endpoints
 * (`/v5/ad_accounts/…`) are not a separate product with a separate credential — they are
 * the same API with ADDITIONAL scopes. Verified against the live API on 2026-08-18:
 *
 *     POST /v5/pins            (no token)                 -> 401 Authentication failed
 *     GET  /v5/ad_accounts     (no token)                 -> 401 Authentication failed
 *     GET  /v5/ad_accounts     (Bearer <PINTEREST_TAG_ID>) -> 401 Authentication failed
 *
 * ⚠ `PINTEREST_TAG_ID` CANNOT authenticate any of this. It is the conversion tag injected
 * into the storefront by /api/pixel/pinterest-script — a public identifier, the Pinterest
 * analogue of the Meta pixel id. It measures conversions; it authorizes nothing. Creating a
 * Pin needs a token consented to `pins:write` (plus `boards:read` to resolve a board), and
 * promoting one additionally needs `ads:read`/`ads:write` — strictly MORE prerequisites,
 * never fewer.
 *
 * ── Dry-run ─────────────────────────────────────────────────────────────────────────────
 * Constructed without credentials (or with `dryRun: true`), the client sends NOTHING: every
 * call is recorded in `client.plan` and answered with a synthetic id, so a caller builds the
 * whole payload through one code path whether or not credentials exist. This is what lets
 * scripts/pinterest-pin-dryrun.mts render a complete Pin against an empty .env.local, and it
 * is why merging this file changes no production behaviour: nothing in src/app imports it.
 */

export const PINTEREST_API_BASE = "https://api.pinterest.com/v5";
/**
 * Apps on Pinterest "Trial" access talk to this separate environment: nothing created there is
 * public, and its tokens do not work on the production base (and vice versa).
 */
export const PINTEREST_SANDBOX_API_BASE = "https://api-sandbox.pinterest.com/v5";
/** Scopes a token must carry for `createPin` / `createVideoPin` to succeed. */
export const PINTEREST_SCOPES = ["pins:write", "boards:read"] as const;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

// ─── Credentials ──────────────────────────────────────────────────────────────────────

export interface PinterestCredentials {
  accessToken: string;
  /** Destination board. Pinterest has no "default board" — a Pin without one is rejected. */
  boardId: string;
  /** Talk to the sandbox environment (Trial access) instead of production. */
  sandbox?: boolean;
}

/** Base URL of the environment these credentials belong to. */
export const pinterestApiBase = (sandbox?: boolean): string => (sandbox ? PINTEREST_SANDBOX_API_BASE : PINTEREST_API_BASE);

/** Env vars this client reads. PINTEREST_TAG_ID is deliberately NOT among them. `PINTEREST_ENV=sandbox` is optional. */
export const PINTEREST_ENV_KEYS = ["PINTEREST_ACCESS_TOKEN", "PINTEREST_BOARD_ID"] as const;

/** Returns null when anything required is missing, so callers degrade to dry-run. */
export function readPinterestCredentials(
  source: Record<string, string | undefined> = process.env,
): PinterestCredentials | null {
  const accessToken = source.PINTEREST_ACCESS_TOKEN;
  const boardId = source.PINTEREST_BOARD_ID;
  if (!accessToken || !boardId) return null;
  return { accessToken, boardId, ...(source.PINTEREST_ENV === "sandbox" ? { sandbox: true } : {}) };
}

/** Which required env vars are missing — for an actionable "run setup" error. */
export function missingPinterestEnv(
  source: Record<string, string | undefined> = process.env,
): string[] {
  return PINTEREST_ENV_KEYS.filter((k) => !source[k]);
}

// ─── Errors ───────────────────────────────────────────────────────────────────────────

/** Flattens Pinterest's `{code, message, status}` envelope into a readable message. */
export class PinterestApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(path: string, status: number, body: unknown) {
    const b = (body ?? {}) as { code?: number; message?: string };
    super(
      `Pinterest ${path} failed (HTTP ${status})` +
        (b.message ? `\n  • ${b.code ?? "?"}: ${b.message}` : ""),
    );
    this.name = "PinterestApiError";
    this.status = status;
    this.code = b.code ?? null;
  }
}

// ─── Pin payload ──────────────────────────────────────────────────────────────────────

export interface PinInput {
  /** Shown in bold above the description. Pinterest truncates past 100 chars. */
  title: string;
  /** Body copy. Pinterest truncates past 800 chars. */
  description: string;
  /** Destination URL — the PDP. */
  link: string;
  /** Publicly reachable image URL. Pinterest fetches it server-side; blobs/data: fail. */
  imageUrl: string;
  /** Optional alt text for accessibility (max 500). */
  altText?: string;
}

export const PIN_TITLE_MAX = 100;
export const PIN_DESCRIPTION_MAX = 800;
export const PIN_ALT_TEXT_MAX = 500;

/** One recorded call, for dry-run rendering and post-run auditing. */
export interface PlannedPin {
  step: string;
  path: string;
  body: unknown;
  pinId: string;
}

/**
 * Build the exact v5 request body for a Pin. Exported separately from the client so the
 * payload can be unit-tested and dry-run-rendered without constructing a client at all.
 *
 * Truncation is deliberate rather than a validation error: a caption two characters over
 * the limit should still publish, not fail the whole queue item at 3am.
 */
export function buildPinBody(input: PinInput, boardId: string): Record<string, unknown> {
  const trim = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");
  return {
    board_id: boardId,
    title: trim(input.title, PIN_TITLE_MAX),
    description: trim(input.description, PIN_DESCRIPTION_MAX),
    link: input.link,
    ...(input.altText ? { alt_text: trim(input.altText, PIN_ALT_TEXT_MAX) } : {}),
    media_source: { source_type: "image_url", url: input.imageUrl },
  };
}

// ─── Video Pins ───────────────────────────────────────────────────────────────────────

export interface VideoPinInput {
  title: string;
  description: string;
  /** Destination URL — the PDP. This is what makes a Pin worth publishing: it is clickable. */
  link: string;
  /** Publicly reachable MP4 (Pinterest takes the bytes from us, not from the URL: we download then upload). */
  videoUrl: string;
  /** REQUIRED by Pinterest for video Pins. Publicly reachable image. */
  coverImageUrl: string;
  altText?: string;
}

/** Pinterest: MP4/MOV/M4V, 4 s – 15 min, at most 100 MB. */
export const PINTEREST_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** Exact v5 body for a Pin whose media was already uploaded (`mediaId`). */
export function buildVideoPinBody(input: VideoPinInput, boardId: string, mediaId: string): Record<string, unknown> {
  const { media_source: _image, ...base } = buildPinBody({ ...input, imageUrl: input.coverImageUrl }, boardId);
  void _image;
  return { ...base, media_source: { source_type: "video_id", media_id: mediaId, cover_image_url: input.coverImageUrl } };
}

/** What `POST /media` answers: where to put the bytes, and the form fields S3 insists on. */
interface RegisteredMedia {
  media_id?: string;
  upload_url?: string;
  upload_parameters?: Record<string, string>;
}
const MEDIA_FAILED = new Set(["failed"]);

/**
 * Flatten HTML to plain text for a Pin description.
 *
 * Aosom's `short_description` is an HTML `<ul>` of bullet points, and Pinterest renders the
 * description as PLAIN TEXT — tags would be shown literally to shoppers. List items become
 * "• " lines so the structure survives the conversion; entities are decoded because
 * "24–32 pairs" must not read as "24&ndash;32 pairs".
 */
export function htmlToPinText(html: string): string {
  return html
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<\s*\/\s*(p|div|ul|ol|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Compose the Pin description from the product fields the social pipeline already has.
 * Price is rendered as plain CAD text — Pinterest reads price from the merchant feed for
 * Rich Pins, not from the caption, so this is human-facing copy only.
 *
 * The caption is run through `htmlToPinText` unconditionally: callers pass either a curated
 * caption (already plain) or a raw Aosom `short_description` (HTML), and the plain case is
 * a no-op.
 */
export function composePinDescription(opts: {
  caption: string;
  priceCad?: number | null;
  brand?: string | null;
}): string {
  const parts = [htmlToPinText(opts.caption)];
  if (typeof opts.priceCad === "number" && Number.isFinite(opts.priceCad)) {
    parts.push(`${opts.priceCad.toFixed(2)} $ CAD · Livraison gratuite au Canada`);
  }
  if (opts.brand) parts.push(opts.brand);
  return parts.filter(Boolean).join("\n\n");
}

// ─── Client ───────────────────────────────────────────────────────────────────────────

export interface PinterestClientOptions {
  /** Record payloads and send nothing. Credentials are not required. */
  dryRun?: boolean;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests: how the video-processing poll waits. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Poll the uploaded video's processing status this often (default 3 s)… */
  pollIntervalMs?: number;
  /** …for at most this long (default 120 s) before giving up. */
  maxWaitMs?: number;
}

export class PinterestClient {
  readonly dryRun: boolean;
  /** Every Pin this client created or planned, in order. */
  readonly plan: PlannedPin[] = [];

  private readonly creds: PinterestCredentials | null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private dryRunCounter = 0;

  constructor(creds: PinterestCredentials | null, options: PinterestClientOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 3_000;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.creds = creds;
    if (!this.dryRun && !creds) {
      throw new Error(
        "PinterestClient: credentials are required unless dryRun is set. " +
          `Missing: ${missingPinterestEnv().join(", ") || "(unknown)"}. ` +
          "Note PINTEREST_TAG_ID is the storefront conversion tag and cannot authenticate the API.",
      );
    }
  }

  /** The board every Pin lands on — the real one, or a marker under dry-run. */
  get boardId(): string {
    return this.creds?.boardId ?? "DRYRUN_BOARD";
  }

  /**
   * Create a Pin. Under dry-run the body is recorded and a synthetic id returned, so callers
   * exercise the same path with or without credentials.
   */
  async createPin(input: PinInput): Promise<{ pinId: string; url: string }> {
    const body = buildPinBody(input, this.boardId);

    if (this.dryRun) {
      const pinId = `dryrun-pin-${++this.dryRunCounter}`;
      this.plan.push({ step: "createPin", path: "/pins", body, pinId });
      return { pinId, url: `https://www.pinterest.com/pin/${pinId}/` };
    }

    const json = (await this.request("/pins", body)) as { id?: string };
    if (!json.id) throw new Error(`Pinterest /pins returned no id: ${JSON.stringify(json).slice(0, 200)}`);
    this.plan.push({ step: "createPin", path: "/pins", body, pinId: json.id });
    return { pinId: json.id, url: `https://www.pinterest.com/pin/${json.id}/` };
  }

  /**
   * Create a video Pin: register the media, upload the bytes (S3, not Pinterest), wait for Pinterest
   * to process them, then create the Pin on the media id. Four calls where an image Pin needs one,
   * which is why each is recorded in `plan` — a half-finished run is diagnosable from it.
   *
   * Under dry-run nothing is downloaded or sent; the planned bodies are recorded with synthetic ids.
   */
  async createVideoPin(input: VideoPinInput): Promise<{ pinId: string; url: string; mediaId: string }> {
    if (this.dryRun) {
      const mediaId = `dryrun-media-${++this.dryRunCounter}`;
      this.plan.push({ step: "registerMedia", path: "/media", body: { media_type: "video" }, pinId: mediaId });
      this.plan.push({ step: "uploadVideo", path: "(upload_url)", body: { source: input.videoUrl }, pinId: mediaId });
      this.plan.push({ step: "awaitMedia", path: `/media/${mediaId}`, body: null, pinId: mediaId });
      const pinId = `dryrun-pin-${++this.dryRunCounter}`;
      this.plan.push({ step: "createPin", path: "/pins", body: buildVideoPinBody(input, this.boardId, mediaId), pinId });
      return { pinId, url: `https://www.pinterest.com/pin/${pinId}/`, mediaId };
    }

    const reg = (await this.request("/media", { media_type: "video" })) as RegisteredMedia;
    if (!reg.media_id || !reg.upload_url || !reg.upload_parameters) {
      throw new Error(`Pinterest /media returned an unexpected answer: ${JSON.stringify(reg).slice(0, 200)}`);
    }
    this.plan.push({ step: "registerMedia", path: "/media", body: { media_type: "video" }, pinId: reg.media_id });

    await this.uploadVideoBytes(input.videoUrl, reg.upload_url, reg.upload_parameters);
    this.plan.push({ step: "uploadVideo", path: "(upload_url)", body: { source: input.videoUrl }, pinId: reg.media_id });

    await this.awaitMedia(reg.media_id);
    this.plan.push({ step: "awaitMedia", path: `/media/${reg.media_id}`, body: null, pinId: reg.media_id });

    const body = buildVideoPinBody(input, this.boardId, reg.media_id);
    const json = (await this.request("/pins", body)) as { id?: string };
    if (!json.id) throw new Error(`Pinterest /pins returned no id: ${JSON.stringify(json).slice(0, 200)}`);
    this.plan.push({ step: "createPin", path: "/pins", body, pinId: json.id });
    return { pinId: json.id, url: `https://www.pinterest.com/pin/${json.id}/`, mediaId: reg.media_id };
  }

  /** Download the MP4 and POST it to the pre-signed upload URL (no Pinterest auth there; S3 wants the `file` field LAST). */
  private async uploadVideoBytes(videoUrl: string, uploadUrl: string, params: Record<string, string>): Promise<void> {
    const src = await this.fetchImpl(videoUrl);
    if (!src.ok) throw new Error(`Pinterest video upload: cannot download ${videoUrl} (HTTP ${src.status})`);
    const bytes = await src.arrayBuffer();
    if (bytes.byteLength > PINTEREST_VIDEO_MAX_BYTES) {
      throw new Error(`Pinterest video upload: ${(bytes.byteLength / 1048576).toFixed(1)} MB exceeds the 100 MB limit`);
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    form.append("file", new Blob([bytes], { type: "video/mp4" }), "video.mp4");
    const up = await this.fetchImpl(uploadUrl, { method: "POST", body: form });
    if (!up.ok) throw new Error(`Pinterest video upload: storage answered HTTP ${up.status}`);
  }

  /** Poll `GET /media/{id}` until Pinterest finished processing the video (or failed / ran out of time). */
  private async awaitMedia(mediaId: string): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      const m = (await this.request(`/media/${mediaId}`, undefined, 0, "GET")) as { status?: string };
      if (m.status === "succeeded") return;
      if (m.status && MEDIA_FAILED.has(m.status)) throw new Error(`Pinterest could not process the video (media ${mediaId}: ${m.status})`);
      if (Date.now() + this.pollIntervalMs > deadline) {
        throw new Error(`Pinterest video still "${m.status ?? "unknown"}" after ${Math.round(this.maxWaitMs / 1000)}s (media ${mediaId})`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** JSON call with a bounded timeout and a retry on 429/5xx. POST unless `method` says otherwise. */
  private async request(path: string, body?: unknown, attempt = 0, method: "GET" | "POST" = "POST"): Promise<unknown> {
    const creds = this.creds;
    if (!creds) throw new Error("PinterestClient: no credentials");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${pinterestApiBase(creds.sandbox)}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Pinterest request timeout after ${REQUEST_TIMEOUT_MS / 1000}s: ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      return this.request(path, body, attempt + 1, method);
    }

    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw new PinterestApiError(path, res.status, json);
    return json;
  }
}

/**
 * Convenience factory: real client when both env vars are present, dry-run client otherwise.
 * Callers therefore never branch on credential presence themselves.
 */
export function pinterestClientFromEnv(
  source: Record<string, string | undefined> = process.env,
): PinterestClient {
  const creds = readPinterestCredentials(source);
  return new PinterestClient(creds, { dryRun: !creds });
}
