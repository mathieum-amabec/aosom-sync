/**
 * TikTok Login Kit (OAuth 2.0, v2) for the Content Posting API: authorize URL, code exchange, refresh and a
 * token store — one set of tokens PER BRAND, because Ameublo Direct (FR) and Furnish Direct (EN) are two
 * separate TikTok accounts.
 *
 * ── Lifetimes (TikTok docs, verified 2026-10) ──────────────────────────────────────────────────────
 *   access token   24 hours
 *   refresh token  365 days; a refresh MAY return a replacement refresh token — always store both.
 * So unlike Pinterest the access token must be refreshed almost every day: `getStoredTokens` refreshes when
 * under REFRESH_MARGIN_S is left, and concurrent callers share one refresh (a rotated refresh token must not
 * be spent twice).
 *
 * ── Redirect URI ───────────────────────────────────────────────────────────────────────────────────
 * TikTok requires an ABSOLUTE `https` URI, static (no query string, no `#`), registered on the app: `localhost`
 * does not work. The helper script therefore works by copy-paste: after the consent screen TikTok sends the
 * browser to <redirect>?code=…&state=…; the page itself does not matter (even a 404), the address bar does.
 *
 * Nothing in src/app imports this: it ships dormant, like the Pinterest modules.
 */

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
/** `video.upload` = send to the user's TikTok inbox as a DRAFT (no audit). `video.publish` (direct, public posting) needs TikTok's audit. */
export const TIKTOK_OAUTH_SCOPES = ["user.info.basic", "video.upload"] as const;
export type TikTokBrand = "fr" | "en";
/** settings key for a brand's tokens. */
export const tiktokTokenSetting = (brand: TikTokBrand) => `tiktok_oauth_${brand}`;
/** Refresh when the 24 h access token has less than this left. */
export const REFRESH_MARGIN_S = 2 * 3600;

export interface TikTokTokenSet {
  access_token: string;
  refresh_token: string;
  /** The user's id for THIS app (needed by some endpoints, handy to tell the two brands apart). */
  open_id: string;
  scope: string;
  /** Unix seconds. */
  expires_at: number;
  /** Unix seconds; null when TikTok did not say. */
  refresh_expires_at: number | null;
  brand: TikTokBrand;
}

export interface TikTokTokenStore {
  load(): Promise<TikTokTokenSet | null>;
  save(tokens: TikTokTokenSet): Promise<void>;
}

export class TikTokAuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "TikTokAuthError";
    this.status = status;
  }
}

interface AppOpts {
  clientKey: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  nowSec?: () => number;
}
const nowOf = (o: { nowSec?: () => number }) => (o.nowSec ?? (() => Math.floor(Date.now() / 1000)))();

/** Where to send the person who owns the TikTok account so they can tap "Authorize". */
export function buildAuthorizeUrl(opts: { clientKey: string; redirectUri: string; state: string; scopes?: readonly string[] }): string {
  const p = new URLSearchParams({
    client_key: opts.clientKey,
    scope: (opts.scopes ?? TIKTOK_OAUTH_SCOPES).join(","),
    response_type: "code",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${TIKTOK_AUTHORIZE_URL}?${p.toString()}`;
}

/** The `code` (and `state`) from the address TikTok redirected to — or a bare code. TikTok may append `*` + junk to the code. */
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
  const res = await f(TIKTOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: opts.clientKey, client_secret: opts.clientSecret, ...form }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // TikTok reports failures in the BODY (`error` / `error_description`), sometimes with an HTTP 200.
  if (!res.ok || json.error) {
    // Never echo the request (it carries the secret / code / refresh token): only TikTok's own message.
    throw new TikTokAuthError(`TikTok OAuth failed (HTTP ${res.status}): ${json.error_description ?? json.error ?? json.message ?? "no message"}`, res.status);
  }
  return json;
}

function toTokenSet(json: Record<string, unknown>, brand: TikTokBrand, opts: AppOpts, previous?: TikTokTokenSet): TikTokTokenSet {
  const now = nowOf(opts);
  const access = String(json.access_token ?? "");
  const refresh = String(json.refresh_token ?? previous?.refresh_token ?? "");
  if (!access || !refresh) throw new TikTokAuthError("TikTok OAuth answered without an access/refresh token");
  const refreshIn = Number(json.refresh_expires_in);
  return {
    access_token: access,
    refresh_token: refresh,
    open_id: String(json.open_id ?? previous?.open_id ?? ""),
    scope: String(json.scope ?? previous?.scope ?? ""),
    expires_at: now + (Number(json.expires_in) || 24 * 3600),
    refresh_expires_at: Number.isFinite(refreshIn) && refreshIn > 0 ? now + refreshIn : (previous?.refresh_expires_at ?? null),
    brand,
  };
}

/** Trade the one-time `code` from the redirect for the token pair. */
export async function exchangeAuthorizationCode(code: string, redirectUri: string, brand: TikTokBrand, opts: AppOpts): Promise<TikTokTokenSet> {
  const json = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, opts);
  return toTokenSet(json, brand, opts);
}

/** Trade the refresh token for a fresh pair. */
export async function refreshTokens(tokens: TikTokTokenSet, opts: AppOpts): Promise<TikTokTokenSet> {
  if (tokens.refresh_expires_at != null && tokens.refresh_expires_at <= nowOf(opts)) {
    throw new TikTokAuthError(`The TikTok refresh token for "${tokens.brand}" expired — authorize again (scripts/tiktok-oauth.mts url / exchange).`);
  }
  const json = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }, opts);
  return toTokenSet(json, tokens.brand, opts, tokens);
}

/** Token store backed by the `settings` table (loaded lazily so importing this file stays side-effect free). */
export function settingsTokenStore(brand: TikTokBrand): TikTokTokenStore {
  const key = tiktokTokenSetting(brand);
  return {
    async load() {
      const { getSetting } = await import("./database");
      const raw = await getSetting(key);
      if (!raw) return null;
      try {
        const t = JSON.parse(raw) as TikTokTokenSet;
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

const inFlight = new Map<string, Promise<TikTokTokenSet>>();

/**
 * A usable token set for a brand, refreshing (and persisting) it first when it is close to expiry.
 * Null when that brand was never authorized. Concurrent callers share one refresh.
 */
export async function getStoredTokens(opts: { store: TikTokTokenStore } & Partial<AppOpts>): Promise<TikTokTokenSet | null> {
  const tokens = await opts.store.load();
  if (!tokens) return null;
  const now = nowOf(opts);
  if (tokens.expires_at - now > REFRESH_MARGIN_S) return tokens;
  if (!opts.clientKey || !opts.clientSecret) {
    if (tokens.expires_at > now) return tokens; // still valid: serve it, refresh once the app credentials are available
    throw new TikTokAuthError("The TikTok access token expired and TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET are not set to refresh it.");
  }
  const key = tokens.brand;
  let p = inFlight.get(key);
  if (!p) {
    p = (async () => {
      const fresh = await refreshTokens(tokens, { clientKey: opts.clientKey!, clientSecret: opts.clientSecret!, fetchImpl: opts.fetchImpl, nowSec: opts.nowSec });
      await opts.store.save(fresh);
      return fresh;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

/** The credentials `TikTokClient` needs for one brand, or null when that brand was never authorized. */
export async function resolveTikTokCredentials(
  brand: TikTokBrand,
  opts: { env?: Record<string, string | undefined>; store?: TikTokTokenStore; fetchImpl?: typeof fetch; nowSec?: () => number } = {},
): Promise<{ accessToken: string; openId: string; brand: TikTokBrand } | null> {
  const env = opts.env ?? process.env;
  const tokens = await getStoredTokens({
    store: opts.store ?? settingsTokenStore(brand),
    clientKey: env.TIKTOK_CLIENT_KEY,
    clientSecret: env.TIKTOK_CLIENT_SECRET,
    fetchImpl: opts.fetchImpl,
    nowSec: opts.nowSec,
  });
  return tokens ? { accessToken: tokens.access_token, openId: tokens.open_id, brand } : null;
}
