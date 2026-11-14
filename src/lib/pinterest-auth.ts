/**
 * Pinterest OAuth 2.0 for the v5 API: authorize URL, code exchange, refresh, and a token store, so
 * `PinterestClient` never depends on a hand-pasted token that dies after 30 days.
 *
 * ── Lifetimes (Pinterest docs, verified 2026-10) ────────────────────────────────────────────────
 *   access token   30 days
 *   refresh token  60 days, "continuous": each refresh issues a new pair, so a connection that is
 *                  refreshed at least every 60 days lives forever without anyone logging in again.
 * We refresh when under REFRESH_MARGIN_S of the access token's life is left, so a daily-or-slower
 * caller is never handed a token about to expire. We always ask for `continuous_refresh=true`.
 *
 * ── Sandbox ────────────────────────────────────────────────────────────────────────────────────
 * Apps on "Trial" access only work against https://api-sandbox.pinterest.com (separate tokens, nothing
 * public). `sandbox: true` points every call here — authorize URL excepted, which is the same page —
 * at that environment. A token minted for one environment is rejected by the other.
 *
 * Nothing in src/app imports this yet: it ships dormant, like pinterest-client.ts.
 */
import { PINTEREST_API_BASE, PINTEREST_SANDBOX_API_BASE, readPinterestCredentials, type PinterestCredentials } from "./pinterest-client";

export const PINTEREST_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";
/** Enough to list boards and create image/video Pins. Add `boards:write` only if we ever create boards. */
export const PINTEREST_OAUTH_SCOPES = ["boards:read", "pins:read", "pins:write"] as const;
/** settings key holding the stored token set (JSON). */
export const PINTEREST_TOKEN_SETTING = "pinterest_oauth";
/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_S = 3 * 24 * 3600;

export interface PinterestTokenSet {
  access_token: string;
  refresh_token: string;
  scope: string;
  /** Unix seconds. */
  expires_at: number;
  /** Unix seconds; null when Pinterest did not say. */
  refresh_expires_at: number | null;
  env: "production" | "sandbox";
}

export interface PinterestTokenStore {
  load(): Promise<PinterestTokenSet | null>;
  save(tokens: PinterestTokenSet): Promise<void>;
}

export class PinterestAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "PinterestAuthError";
    this.status = status;
  }
}

interface AppOpts {
  appId: string;
  appSecret: string;
  sandbox?: boolean;
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
}

const tokenEndpoint = (sandbox?: boolean) => `${sandbox ? PINTEREST_SANDBOX_API_BASE : PINTEREST_API_BASE}/oauth/token`;

/** Where to send the person who owns the Pinterest account so they can click "Give access". */
export function buildAuthorizeUrl(opts: { appId: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
  const p = new URLSearchParams({
    client_id: opts.appId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: (opts.scopes ?? PINTEREST_OAUTH_SCOPES).join(","),
    state: opts.state,
  });
  return `${PINTEREST_AUTHORIZE_URL}?${p.toString()}`;
}

/** The `code` (and the `state` to compare) from the address Pinterest redirected to — or a bare code. */
export function parseAuthorizationCode(input: string): { code: string; state: string | null } {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw) || raw.includes("code=")) {
    const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
    const params = new URLSearchParams(q.split("#")[0]);
    return { code: params.get("code") ?? "", state: params.get("state") };
  }
  return { code: raw, state: null };
}

async function tokenRequest(form: Record<string, string>, opts: AppOpts): Promise<Record<string, unknown>> {
  const f = opts.fetchImpl ?? fetch;
  const basic = Buffer.from(`${opts.appId}:${opts.appSecret}`).toString("base64");
  const res = await f(tokenEndpoint(opts.sandbox), {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Never echo the request (it carries the secret / refresh token): only Pinterest's own message.
    throw new PinterestAuthError(`Pinterest OAuth failed (HTTP ${res.status}): ${json.message ?? json.error_description ?? json.error ?? "no message"}`, res.status);
  }
  return json;
}

function toTokenSet(json: Record<string, unknown>, opts: AppOpts, previousRefresh?: string): PinterestTokenSet {
  const now = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const access = String(json.access_token ?? "");
  const refresh = String(json.refresh_token ?? previousRefresh ?? "");
  if (!access || !refresh) throw new PinterestAuthError("Pinterest OAuth answered without an access/refresh token");
  const refreshIn = Number(json.refresh_token_expires_in);
  return {
    access_token: access,
    refresh_token: refresh,
    scope: String(json.scope ?? ""),
    expires_at: now + (Number(json.expires_in) || 30 * 24 * 3600),
    refresh_expires_at: Number.isFinite(refreshIn) && refreshIn > 0 ? now + refreshIn : null,
    env: opts.sandbox ? "sandbox" : "production",
  };
}

/** Trade the one-time `code` from the redirect for the token pair. */
export async function exchangeAuthorizationCode(code: string, redirectUri: string, opts: AppOpts): Promise<PinterestTokenSet> {
  const json = await tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri, continuous_refresh: "true" },
    opts,
  );
  return toTokenSet(json, opts);
}

/** Trade the refresh token for a fresh pair (continuous refresh). */
export async function refreshTokens(tokens: PinterestTokenSet, opts: AppOpts): Promise<PinterestTokenSet> {
  const now = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  if (tokens.refresh_expires_at != null && tokens.refresh_expires_at <= now) {
    throw new PinterestAuthError("The Pinterest refresh token expired — authorize again (scripts/pinterest-oauth.mts url / exchange).");
  }
  const json = await tokenRequest(
    { grant_type: "refresh_token", refresh_token: tokens.refresh_token, continuous_refresh: "true" },
    { ...opts, sandbox: tokens.env === "sandbox" },
  );
  return toTokenSet(json, { ...opts, sandbox: tokens.env === "sandbox" }, tokens.refresh_token);
}

/**
 * Token store backed by the `settings` table (loaded lazily so importing this file stays side-effect free).
 * Sandbox and production tokens live under separate keys: they are not interchangeable.
 */
export function settingsTokenStore(env: "production" | "sandbox" = "production"): PinterestTokenStore {
  const key = env === "sandbox" ? `${PINTEREST_TOKEN_SETTING}_sandbox` : PINTEREST_TOKEN_SETTING;
  return {
    async load() {
      const { getSetting } = await import("./database");
      const raw = await getSetting(key);
      if (!raw) return null;
      try {
        const t = JSON.parse(raw) as PinterestTokenSet;
        return t.access_token && t.refresh_token ? t : null;
      } catch {
        return null;
      }
    },
    async save(tokens) {
      const { setSetting } = await import("./database");
      await setSetting(key, JSON.stringify(tokens));
    },
  };
}

const inFlight = new Map<string, Promise<PinterestTokenSet>>();

/**
 * A usable access token, refreshing (and persisting) it first when it is close to expiry.
 * Returns null when nothing was ever authorized. Concurrent callers share one refresh.
 */
export async function getStoredTokens(opts: { store: PinterestTokenStore } & Partial<AppOpts>): Promise<PinterestTokenSet | null> {
  const tokens = await opts.store.load();
  if (!tokens) return null;
  const now = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  if (tokens.expires_at - now > REFRESH_MARGIN_S) return tokens;
  if (!opts.appId || !opts.appSecret) {
    if (tokens.expires_at > now) return tokens; // still valid: serve it, refresh once the app credentials are available
    throw new PinterestAuthError("The Pinterest access token expired and PINTEREST_APP_ID / PINTEREST_APP_SECRET are not set to refresh it.");
  }
  const key = tokens.env;
  let p = inFlight.get(key);
  if (!p) {
    p = (async () => {
      const fresh = await refreshTokens(tokens, { appId: opts.appId!, appSecret: opts.appSecret!, fetchImpl: opts.fetchImpl, nowSec: opts.nowSec });
      await opts.store.save(fresh);
      return fresh;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

/**
 * The credentials `PinterestClient` needs: the stored OAuth tokens when there are any (kept fresh),
 * otherwise the static `PINTEREST_ACCESS_TOKEN` env var. The board always comes from `PINTEREST_BOARD_ID`.
 * Null means "nothing configured": callers degrade to dry-run.
 */
export async function resolvePinterestCredentials(opts: {
  env?: Record<string, string | undefined>;
  store?: PinterestTokenStore;
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
} = {}): Promise<PinterestCredentials | null> {
  const env = opts.env ?? process.env;
  const boardId = env.PINTEREST_BOARD_ID;
  if (!boardId) return null;
  const tokens = await getStoredTokens({
    store: opts.store ?? settingsTokenStore(env.PINTEREST_ENV === "sandbox" ? "sandbox" : "production"),
    appId: env.PINTEREST_APP_ID,
    appSecret: env.PINTEREST_APP_SECRET,
    fetchImpl: opts.fetchImpl,
    nowSec: opts.nowSec,
  });
  if (tokens) return { accessToken: tokens.access_token, boardId, ...(tokens.env === "sandbox" ? { sandbox: true } : {}) };
  return readPinterestCredentials(env);
}
