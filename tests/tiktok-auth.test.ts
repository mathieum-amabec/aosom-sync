import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAuthorizeUrl,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  refreshTokens,
  getStoredTokens,
  resolveTikTokCredentials,
  tiktokTokenSetting,
  REFRESH_MARGIN_S,
  type TikTokTokenSet,
  type TikTokTokenStore,
} from "@/lib/tiktok-auth";

const NOW = 1_800_000_000;
const APP = { clientKey: "awxyz", clientSecret: "s3cr3t", nowSec: () => NOW };
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const tokenJson = { access_token: "act.NEW", refresh_token: "rft.NEW", open_id: "oid-1", scope: "user.info.basic,video.upload", expires_in: 86_400, refresh_expires_in: 31_536_000, token_type: "Bearer" };
const stored = (o: Partial<TikTokTokenSet> = {}): TikTokTokenSet => ({
  access_token: "act.OLD", refresh_token: "rft.OLD", open_id: "oid-1", scope: "user.info.basic,video.upload",
  expires_at: NOW + 20 * 3600, refresh_expires_at: NOW + 300 * 86400, brand: "fr", ...o,
});
function memoryStore(initial: TikTokTokenSet | null) {
  let cur = initial;
  const store: TikTokTokenStore = { load: async () => cur, save: async (t) => { cur = t; } };
  return { store, get: () => cur };
}
const callArgs = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] as unknown as [string, RequestInit];
const form = (init: RequestInit) => Object.fromEntries(new URLSearchParams(init.body as string));

describe("buildAuthorizeUrl / parseAuthorizationCode", () => {
  it("asks for the code flow with comma-joined scopes, the registered https redirect and a state", () => {
    const u = new URL(buildAuthorizeUrl({ clientKey: "awxyz", redirectUri: "https://ameublodirect.ca/", state: "st" }));
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_key: "awxyz", scope: "user.info.basic,video.upload", response_type: "code", redirect_uri: "https://ameublodirect.ca/", state: "st",
    });
  });
  it("never asks for the public-posting scope by default — that one needs TikTok's audit", () => {
    expect(buildAuthorizeUrl({ clientKey: "k", redirectUri: "https://x.ca/", state: "s" })).not.toContain("video.publish");
  });
  it("takes the code from a pasted redirect URL, a bare query, or a bare code", () => {
    expect(parseAuthorizationCode("https://ameublodirect.ca/?code=ABC*1!xyz&scopes=user.info.basic&state=st")).toEqual({ code: "ABC*1!xyz", state: "st" });
    expect(parseAuthorizationCode("code=ABC&state=st")).toEqual({ code: "ABC", state: "st" });
    expect(parseAuthorizationCode(" ABC ")).toEqual({ code: "ABC", state: null });
  });
});

describe("exchangeAuthorizationCode", () => {
  it("POSTs the code form-encoded with the app key/secret and the same redirect URI", async () => {
    const fetchImpl = vi.fn(async () => res(tokenJson));
    const t = await exchangeAuthorizationCode("CODE", "https://ameublodirect.ca/", "fr", { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe("https://open.tiktokapis.com/v2/oauth/token/");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(form(init)).toEqual({ client_key: "awxyz", client_secret: "s3cr3t", code: "CODE", grant_type: "authorization_code", redirect_uri: "https://ameublodirect.ca/" });
    expect(t).toEqual({
      access_token: "act.NEW", refresh_token: "rft.NEW", open_id: "oid-1", scope: "user.info.basic,video.upload",
      expires_at: NOW + 86_400, refresh_expires_at: NOW + 31_536_000, brand: "fr",
    });
  });

  it("surfaces TikTok's message — also when it answers HTTP 200 with an error body — and never echoes secrets", async () => {
    const fetchImpl = vi.fn(async () => res({ error: "invalid_grant", error_description: "Authorization code is expired.", log_id: "L" }, 200));
    const err = (await exchangeAuthorizationCode("CODE-123", "https://x.ca/", "en", { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e)) as Error;
    expect(err.message).toContain("Authorization code is expired");
    expect(err.message).not.toContain("s3cr3t");
    expect(err.message).not.toContain("CODE-123");
  });

  it("refuses an answer without tokens", async () => {
    const fetchImpl = vi.fn(async () => res({ open_id: "x" }));
    await expect(exchangeAuthorizationCode("C", "r", "fr", { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/without an access\/refresh token/);
  });
});

describe("refreshTokens", () => {
  it("sends the refresh token and returns the new pair for the same brand", async () => {
    const fetchImpl = vi.fn(async () => res(tokenJson));
    const t = await refreshTokens(stored({ brand: "en" }), { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(form(callArgs(fetchImpl)[1])).toEqual({ client_key: "awxyz", client_secret: "s3cr3t", grant_type: "refresh_token", refresh_token: "rft.OLD" });
    expect(t).toMatchObject({ access_token: "act.NEW", refresh_token: "rft.NEW", brand: "en" });
  });
  it("keeps the previous refresh token, open_id and scope when TikTok returns none of them", async () => {
    const fetchImpl = vi.fn(async () => res({ access_token: "a2", expires_in: 100 }));
    const t = await refreshTokens(stored(), { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(t).toMatchObject({ refresh_token: "rft.OLD", open_id: "oid-1", scope: "user.info.basic,video.upload" });
  });
  it("tells you to authorize again when the refresh token itself has expired — without calling TikTok", async () => {
    const fetchImpl = vi.fn();
    await expect(refreshTokens(stored({ refresh_expires_at: NOW - 1 }), { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/authorize again/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("getStoredTokens", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchImpl = vi.fn(async () => res(tokenJson));
  });
  const f = () => fetchImpl as unknown as typeof fetch;

  it("returns null when that brand was never authorized", async () => {
    expect(await getStoredTokens({ store: memoryStore(null).store, ...APP, fetchImpl: f() })).toBeNull();
  });
  it("serves a token with hours left, without any network call", async () => {
    const t = await getStoredTokens({ store: memoryStore(stored()).store, ...APP, fetchImpl: f() });
    expect(t!.access_token).toBe("act.OLD");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refreshes and persists when under the margin (the access token only lives 24 h)", async () => {
    const m = memoryStore(stored({ expires_at: NOW + REFRESH_MARGIN_S - 60 }));
    const t = await getStoredTokens({ store: m.store, ...APP, fetchImpl: f() });
    expect(t!.access_token).toBe("act.NEW");
    expect(m.get()!.refresh_token).toBe("rft.NEW");
  });
  it("lets concurrent callers share ONE refresh (a rotated refresh token must not be spent twice)", async () => {
    const m = memoryStore(stored({ expires_at: NOW + 60 }));
    const all = await Promise.all([1, 2, 3].map(() => getStoredTokens({ store: m.store, ...APP, fetchImpl: f() })));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(all.map((t) => t!.access_token)).toEqual(["act.NEW", "act.NEW", "act.NEW"]);
  });
  it("without app credentials: serves a still-valid token, refuses an expired one", async () => {
    expect((await getStoredTokens({ store: memoryStore(stored({ expires_at: NOW + 600 })).store, nowSec: APP.nowSec }))!.access_token).toBe("act.OLD");
    await expect(getStoredTokens({ store: memoryStore(stored({ expires_at: NOW - 1 })).store, nowSec: APP.nowSec })).rejects.toThrow(/TIKTOK_CLIENT_KEY/);
  });
});

describe("resolveTikTokCredentials / settings key", () => {
  const fetchImpl = vi.fn(async () => res(tokenJson)) as unknown as typeof fetch;
  it("keeps one token set per brand under its own settings key", () => {
    expect(tiktokTokenSetting("fr")).toBe("tiktok_oauth_fr");
    expect(tiktokTokenSetting("en")).toBe("tiktok_oauth_en");
  });
  it("returns the brand's token and open_id", async () => {
    const env = { TIKTOK_CLIENT_KEY: "k", TIKTOK_CLIENT_SECRET: "s" };
    expect(await resolveTikTokCredentials("fr", { env, store: memoryStore(stored()).store, fetchImpl, nowSec: APP.nowSec })).toEqual({ accessToken: "act.OLD", openId: "oid-1", brand: "fr" });
  });
  it("is null when the brand was never authorized", async () => {
    expect(await resolveTikTokCredentials("en", { env: {}, store: memoryStore(null).store, fetchImpl })).toBeNull();
  });
});
