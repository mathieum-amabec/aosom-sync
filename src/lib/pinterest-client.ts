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
/** Scopes a token must carry for `createPin` to succeed. */
export const PINTEREST_SCOPES = ["pins:write", "boards:read"] as const;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

// ─── Credentials ──────────────────────────────────────────────────────────────────────

export interface PinterestCredentials {
  accessToken: string;
  /** Destination board. Pinterest has no "default board" — a Pin without one is rejected. */
  boardId: string;
}

/** Env vars this client reads. PINTEREST_TAG_ID is deliberately NOT among them. */
export const PINTEREST_ENV_KEYS = ["PINTEREST_ACCESS_TOKEN", "PINTEREST_BOARD_ID"] as const;

/** Returns null when anything required is missing, so callers degrade to dry-run. */
export function readPinterestCredentials(
  source: Record<string, string | undefined> = process.env,
): PinterestCredentials | null {
  const accessToken = source.PINTEREST_ACCESS_TOKEN;
  const boardId = source.PINTEREST_BOARD_ID;
  if (!accessToken || !boardId) return null;
  return { accessToken, boardId };
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
}

export class PinterestClient {
  readonly dryRun: boolean;
  /** Every Pin this client created or planned, in order. */
  readonly plan: PlannedPin[] = [];

  private readonly creds: PinterestCredentials | null;
  private readonly fetchImpl: typeof fetch;
  private dryRunCounter = 0;

  constructor(creds: PinterestCredentials | null, options: PinterestClientOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  /** POST with a bounded timeout and a retry on 429/5xx. */
  private async request(path: string, body: unknown, attempt = 0): Promise<unknown> {
    const creds = this.creds;
    if (!creds) throw new Error("PinterestClient: no credentials");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${PINTEREST_API_BASE}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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
      return this.request(path, body, attempt + 1);
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
