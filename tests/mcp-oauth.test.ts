import { describe, it, expect, vi, beforeEach } from "vitest";
import { pkceChallenge, pkceMatches, isAllowedRedirectUri, escapeHtml, hashToken } from "@/lib/mcp/oauth";

const db = vi.hoisted(() => ({
  registerOAuthClient: vi.fn(), getOAuthClient: vi.fn(), createOAuthGrantWithCode: vi.fn(), consumeOAuthCode: vi.fn(),
  consumeOAuthRefresh: vi.fn(), storeOAuthTokens: vi.fn(), verifyOAuthAccess: vi.fn(), verifyMcpKey: vi.fn(),
  ensureSchema: vi.fn(async () => ({ execute: vi.fn(async () => ({ rows: [] })) })),
}));
vi.mock("@/lib/database", () => db);
const session = vi.hoisted(() => ({ current: null as null | { username: string; role: string } }));
vi.mock("@/lib/auth", () => ({ getSession: async () => session.current }));

const { POST: register } = await import("@/app/oauth/register/route");
const { POST: token } = await import("@/app/oauth/token/route");
const { GET: authGet, POST: authPost } = await import("@/app/oauth/authorize/route");
const { POST: mcp } = await import("@/app/api/mcp/route");

const VERIFIER = "v".repeat(60);
const CHALLENGE = pkceChallenge(VERIFIER);
const CB = "https://claude.ai/api/mcp/auth_callback";

const resetDb = () => {
  for (const key of ["registerOAuthClient", "getOAuthClient", "createOAuthGrantWithCode", "consumeOAuthCode", "consumeOAuthRefresh", "storeOAuthTokens", "verifyOAuthAccess", "verifyMcpKey"] as const) db[key].mockReset();
};

describe("oauth helpers", () => {
  it("PKCE S256 matches only the right verifier", () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
    expect(pkceMatches("w".repeat(60), CHALLENGE)).toBe(false);
    expect(pkceMatches("short", pkceChallenge("short"))).toBe(false);
  });
  it("redirect allowlist: Anthropic + loopback only", () => {
    for (const ok of [CB, "https://claude.com/api/mcp/auth_callback", "http://localhost:6274/cb", "http://127.0.0.1/cb"]) expect(isAllowedRedirectUri(ok)).toBe(true);
    for (const bad of ["https://evil.example/cb", "https://claude.ai.evil.com/cb", "http://claude.ai/cb", "javascript:alert(1)", "https://claude.ai/cb#x", "nope"]) expect(isAllowedRedirectUri(bad)).toBe(false);
  });
  it("escapes HTML", () => expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;"));
});

describe("registration + token", () => {
  beforeEach(resetDb);

  it("register rejects a foreign redirect URI and accepts claude.ai", async () => {
    const req = (uris: string[]) => new Request("http://x/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: uris, client_name: "Claude" }) });
    expect((await register(req(["https://evil.example/cb"]))).status).toBe(400);
    const ok = await register(req([CB]));
    expect(ok.status).toBe(201);
    expect((await ok.json()).client_id).toMatch(/^cl_/);
    expect(db.registerOAuthClient).toHaveBeenCalledTimes(1);
  });

  const tok = (form: Record<string, string>) =>
    token(new Request("http://x/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }));

  it("code exchange: PKCE + redirect_uri + client must all match; success issues tokens", async () => {
    db.getOAuthClient.mockResolvedValue({ client_id: "cl_1", client_name: "Claude", redirect_uris: [CB] });
    db.consumeOAuthCode.mockResolvedValue({ grant_id: 7, client_id: "cl_1", redirect_uri: CB, code_challenge: CHALLENGE });
    const base = { grant_type: "authorization_code", client_id: "cl_1", code: "ac_x", redirect_uri: CB };
    expect((await tok({ ...base, code_verifier: "w".repeat(60) })).status).toBe(400);
    expect((await tok({ ...base, redirect_uri: "https://claude.ai/other", code_verifier: VERIFIER })).status).toBe(400);
    const ok = await tok({ ...base, code_verifier: VERIFIER });
    expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.access_token).toMatch(/^amcpa_/);
    expect(j.refresh_token).toMatch(/^amcpr_/);
    const stored = db.storeOAuthTokens.mock.calls[0];
    expect(stored[0]).toBe(7);
    expect(stored[1].hash).toBe(hashToken(j.access_token)); // only hashes are stored
  });

  it("unknown client is 401; used/expired code is invalid_grant; refresh rotates", async () => {
    db.getOAuthClient.mockResolvedValue(null);
    expect((await tok({ grant_type: "authorization_code", client_id: "nope" })).status).toBe(401);
    db.getOAuthClient.mockResolvedValue({ client_id: "cl_1", client_name: "Claude", redirect_uris: [CB] });
    db.consumeOAuthCode.mockResolvedValue(null);
    expect((await tok({ grant_type: "authorization_code", client_id: "cl_1", code: "ac_x", redirect_uri: CB, code_verifier: VERIFIER })).status).toBe(400);
    db.consumeOAuthRefresh.mockResolvedValue({ grant_id: 7, client_id: "cl_1" });
    expect((await tok({ grant_type: "refresh_token", client_id: "cl_1", refresh_token: "amcpr_x" })).status).toBe(200);
  });
});

describe("authorize (consent page)", () => {
  const q = new URLSearchParams({ client_id: "cl_1", redirect_uri: CB, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st" });
  const url = `http://x/oauth/authorize?${q}`;
  beforeEach(() => {
    resetDb();
    session.current = null;
    db.getOAuthClient.mockResolvedValue({ client_id: "cl_1", client_name: "Claude <b>", redirect_uris: [CB] });
  });

  it("never redirects to an unregistered redirect_uri", async () => {
    const bad = url.replace(encodeURIComponent(CB), encodeURIComponent("https://evil.example/cb"));
    const r = await authGet(new Request(bad));
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });
  it("sends a signed-out visitor to /login with a return path", async () => {
    const r = await authGet(new Request(url));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/login?redirect=%2Foauth%2Fauthorize");
  });
  it("non-admin gets 403; admin sees an escaped consent page", async () => {
    session.current = { username: "rev", role: "reviewer" };
    expect((await authGet(new Request(url))).status).toBe(403);
    session.current = { username: "admin", role: "admin" };
    const r = await authGet(new Request(url));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Claude &lt;b&gt;");
    expect(html).not.toContain("<b>Claude");
  });
  it("approve issues a code to the registered URI; deny returns access_denied; no session is 403", async () => {
    const form = (decision: string) => new Request("http://x/oauth/authorize", { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(q), decision }) });
    expect((await authPost(form("approve"))).status).toBe(403);
    session.current = { username: "admin", role: "admin" };
    const ok = await authPost(form("approve"));
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CB);
    expect(loc.searchParams.get("code")).toMatch(/^ac_/);
    expect(loc.searchParams.get("state")).toBe("st");
    expect(db.createOAuthGrantWithCode.mock.calls[0][0].codeHash).toBe(hashToken(loc.searchParams.get("code")!));
    expect(db.createOAuthGrantWithCode.mock.calls[0][0].scope).toBe("read"); // nothing ticked = read only
    const no = await authPost(form("deny"));
    expect(new URL(no.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });
  it("rejects a cross-origin form post", async () => {
    session.current = { username: "admin", role: "admin" };
    const r = await authPost(new Request("http://x/oauth/authorize", { method: "POST", headers: { origin: "https://evil.example" }, body: new URLSearchParams({ decision: "approve" }) }));
    expect(r.status).toBe(403);
  });
});

describe("/api/mcp with OAuth", () => {
  it("accepts a live access token; a 401 carries the resource_metadata hint", async () => {
    resetDb();
    db.verifyOAuthAccess.mockResolvedValue("read analytics");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const tokenStr = "amcpa_" + "a".repeat(43);
    const ok = await mcp(new Request("https://h/api/mcp", { method: "POST", headers: { authorization: `Bearer ${tokenStr}` }, body }));
    expect(ok.status).toBe(200);
    expect(db.verifyOAuthAccess).toHaveBeenCalledWith(hashToken(tokenStr));
    const no = await mcp(new Request("https://h/api/mcp", { method: "POST", body }));
    expect(no.status).toBe(401);
    expect(no.headers.get("www-authenticate")).toContain('resource_metadata="https://h/.well-known/oauth-protected-resource/api/mcp"');
  });
});
