import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAuthorizeUrl,
  parseAuthorizationCode,
  exchangeAuthorizationCode,
  refreshTokens,
  getStoredTokens,
  resolvePinterestCredentials,
  REFRESH_MARGIN_S,
  type PinterestTokenSet,
  type PinterestTokenStore,
} from "@/lib/pinterest-auth";

const NOW = 1_800_000_000;
const APP = { appId: "1620054", appSecret: "s3cr3t", nowSec: () => NOW };
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const tokenJson = { access_token: "acc-NEW", refresh_token: "ref-NEW", scope: "boards:read,pins:read,pins:write", expires_in: 2_592_000, refresh_token_expires_in: 5_184_000 };

const stored = (o: Partial<PinterestTokenSet> = {}): PinterestTokenSet => ({
  access_token: "acc-OLD", refresh_token: "ref-OLD", scope: "pins:write", expires_at: NOW + 10 * 86400, refresh_expires_at: NOW + 50 * 86400, env: "production", ...o,
});
function memoryStore(initial: PinterestTokenSet | null) {
  let cur = initial;
  const store: PinterestTokenStore = { load: async () => cur, save: async (t) => { cur = t; } };
  return { store, get: () => cur };
}
const callArgs = (f: ReturnType<typeof vi.fn>) => f.mock.calls[0] as unknown as [string, RequestInit];

describe("buildAuthorizeUrl / parseAuthorizationCode", () => {
  it("asks for the code flow with the comma-joined scopes and a state", () => {
    const u = new URL(buildAuthorizeUrl({ appId: "1620054", redirectUri: "http://localhost:8085/", state: "abc" }));
    expect(u.origin + u.pathname).toBe("https://www.pinterest.com/oauth/");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "1620054", redirect_uri: "http://localhost:8085/", response_type: "code", scope: "boards:read,pins:read,pins:write", state: "abc",
    });
  });
  it("takes the code from a pasted redirect URL, a bare query, or a bare code", () => {
    expect(parseAuthorizationCode("http://localhost:8085/?code=XYZ&state=st#_")).toEqual({ code: "XYZ", state: "st" });
    expect(parseAuthorizationCode("code=XYZ&state=st")).toEqual({ code: "XYZ", state: "st" });
    expect(parseAuthorizationCode("  XYZ ")).toEqual({ code: "XYZ", state: null });
  });
});

describe("exchangeAuthorizationCode", () => {
  it("POSTs the code with HTTP Basic app credentials and asks for continuous refresh", async () => {
    const fetchImpl = vi.fn(async () => res(tokenJson));
    const t = await exchangeAuthorizationCode("CODE", "http://localhost:8085/", { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = callArgs(fetchImpl);
    expect(url).toBe("https://api.pinterest.com/v5/oauth/token");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("1620054:s3cr3t").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: "authorization_code", code: "CODE", redirect_uri: "http://localhost:8085/", continuous_refresh: "true",
    });
    expect(t).toEqual({
      access_token: "acc-NEW", refresh_token: "ref-NEW", scope: "boards:read,pins:read,pins:write",
      expires_at: NOW + 2_592_000, refresh_expires_at: NOW + 5_184_000, env: "production",
    });
  });

  it("talks to the sandbox endpoint and labels the tokens sandbox", async () => {
    const fetchImpl = vi.fn(async () => res(tokenJson));
    const t = await exchangeAuthorizationCode("C", "r", { ...APP, sandbox: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(callArgs(fetchImpl)[0]).toBe("https://api-sandbox.pinterest.com/v5/oauth/token");
    expect(t.env).toBe("sandbox");
  });

  it("surfaces Pinterest's message without ever echoing the secret or the code", async () => {
    const fetchImpl = vi.fn(async () => res({ code: 3, message: "Invalid code" }, 400));
    const err = (await exchangeAuthorizationCode("CODE-123", "r", { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((e) => e)) as Error;
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("Invalid code");
    expect(err.message).not.toContain("s3cr3t");
    expect(err.message).not.toContain("CODE-123");
  });

  it("refuses an answer without tokens", async () => {
    const fetchImpl = vi.fn(async () => res({ token_type: "bearer" }));
    await expect(exchangeAuthorizationCode("C", "r", { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(/without an access\/refresh token/);
  });
});

describe("refreshTokens", () => {
  it("sends the refresh token and returns the new pair", async () => {
    const fetchImpl = vi.fn(async () => res(tokenJson));
    const t = await refreshTokens(stored(), { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(Object.fromEntries(new URLSearchParams(callArgs(fetchImpl)[1].body as string))).toEqual({
      grant_type: "refresh_token", refresh_token: "ref-OLD", continuous_refresh: "true",
    });
    expect(t.access_token).toBe("acc-NEW");
  });
  it("keeps the previous refresh token when Pinterest does not return a new one", async () => {
    const fetchImpl = vi.fn(async () => res({ access_token: "a2", expires_in: 100 }));
    const t = await refreshTokens(stored(), { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(t.refresh_token).toBe("ref-OLD");
  });
  it("refreshes against the environment the tokens belong to", async () => {
    const fetchImpl = vi.fn(async () => res(tokenJson));
    const t = await refreshTokens(stored({ env: "sandbox" }), { ...APP, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(callArgs(fetchImpl)[0]).toContain("api-sandbox.pinterest.com");
    expect(t.env).toBe("sandbox");
  });
  it("tells you to authorize again when the refresh token itself has expired — without calling Pinterest", async () => {
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

  it("returns null when nothing was ever authorized", async () => {
    expect(await getStoredTokens({ store: memoryStore(null).store, ...APP, fetchImpl: f() })).toBeNull();
  });
  it("serves a token with plenty of life left, without any network call", async () => {
    const t = await getStoredTokens({ store: memoryStore(stored()).store, ...APP, fetchImpl: f() });
    expect(t!.access_token).toBe("acc-OLD");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("refreshes and persists when under the margin", async () => {
    const m = memoryStore(stored({ expires_at: NOW + REFRESH_MARGIN_S - 60 }));
    const t = await getStoredTokens({ store: m.store, ...APP, fetchImpl: f() });
    expect(t!.access_token).toBe("acc-NEW");
    expect(m.get()!.refresh_token).toBe("ref-NEW");
  });
  it("lets concurrent callers share ONE refresh (a rotating refresh token must not be spent twice)", async () => {
    const m = memoryStore(stored({ expires_at: NOW + 60 }));
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => getStoredTokens({ store: m.store, ...APP, fetchImpl: f() })));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect([a!.access_token, b!.access_token, c!.access_token]).toEqual(["acc-NEW", "acc-NEW", "acc-NEW"]);
  });
  it("without app credentials: serves a still-valid token, refuses an expired one", async () => {
    const soon = memoryStore(stored({ expires_at: NOW + 3600 }));
    expect((await getStoredTokens({ store: soon.store, nowSec: APP.nowSec }))!.access_token).toBe("acc-OLD");
    const dead = memoryStore(stored({ expires_at: NOW - 1 }));
    await expect(getStoredTokens({ store: dead.store, nowSec: APP.nowSec })).rejects.toThrow(/PINTEREST_APP_ID/);
  });
});

describe("resolvePinterestCredentials", () => {
  const fetchImpl = vi.fn(async () => res(tokenJson)) as unknown as typeof fetch;
  it("is null without a board — a Pin cannot land anywhere", async () => {
    expect(await resolvePinterestCredentials({ env: {}, store: memoryStore(stored()).store, fetchImpl })).toBeNull();
  });
  it("uses the stored OAuth tokens, flagging sandbox ones", async () => {
    const env = { PINTEREST_BOARD_ID: "b1", PINTEREST_APP_ID: "1", PINTEREST_APP_SECRET: "s" };
    expect(await resolvePinterestCredentials({ env, store: memoryStore(stored()).store, fetchImpl, nowSec: APP.nowSec })).toEqual({ accessToken: "acc-OLD", boardId: "b1" });
    expect(await resolvePinterestCredentials({ env, store: memoryStore(stored({ env: "sandbox" })).store, fetchImpl, nowSec: APP.nowSec })).toEqual({
      accessToken: "acc-OLD", boardId: "b1", sandbox: true,
    });
  });
  it("falls back to the static PINTEREST_ACCESS_TOKEN when nothing is stored", async () => {
    const env = { PINTEREST_BOARD_ID: "b1", PINTEREST_ACCESS_TOKEN: "static", PINTEREST_ENV: "sandbox" };
    expect(await resolvePinterestCredentials({ env, store: memoryStore(null).store, fetchImpl })).toEqual({ accessToken: "static", boardId: "b1", sandbox: true });
  });
  it("is null when neither source has a token", async () => {
    expect(await resolvePinterestCredentials({ env: { PINTEREST_BOARD_ID: "b1" }, store: memoryStore(null).store, fetchImpl })).toBeNull();
  });
});
