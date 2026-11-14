import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateMcpKey, hashMcpKey, mcpKeyHint, bearerKey } from "@/lib/mcp/keys";

const { verify, execute } = vi.hoisted(() => ({ verify: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/database", () => ({ verifyMcpKey: verify, verifyOAuthAccess: async () => false, ensureSchema: async () => ({ execute }) }));
const { POST, GET } = await import("@/app/api/mcp/route");

describe("mcp keys", () => {
  it("generates unguessable, prefixed keys and hashes them deterministically", () => {
    const a = generateMcpKey(), b = generateMcpKey();
    expect(a).toMatch(/^amcp_[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
    expect(hashMcpKey(a)).toBe(hashMcpKey(a));
    expect(hashMcpKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(mcpKeyHint(a)).toBe(a.slice(0, 9));
    expect(mcpKeyHint(a).length).toBeLessThan(a.length);
  });
  it("bearerKey only accepts a well-formed amcp_ bearer", () => {
    const k = generateMcpKey();
    expect(bearerKey(`Bearer ${k}`)).toBe(k);
    expect(bearerKey(`Bearer wrong`)).toBeNull();
    expect(bearerKey(k)).toBeNull();
    expect(bearerKey(null)).toBeNull();
  });
});

describe("POST /api/mcp", () => {
  const key = generateMcpKey();
  const req = (body: unknown, auth: string | null = `Bearer ${key}`) =>
    new Request("http://x/api/mcp", { method: "POST", headers: auth ? { authorization: auth } : {}, body: typeof body === "string" ? body : JSON.stringify(body) });
  beforeEach(() => { verify.mockReset(); execute.mockReset().mockResolvedValue({ rows: [] }); });

  it("401 without a key, and the DB is never consulted", async () => {
    expect((await POST(req({ id: 1, method: "ping" }, null))).status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });
  it("401 for an unknown / revoked key", async () => {
    verify.mockResolvedValue(null);
    expect((await POST(req({ id: 1, method: "ping" }))).status).toBe(401);
    expect(verify).toHaveBeenCalledWith(hashMcpKey(key));
  });
  it("answers JSON-RPC for a valid key and 202 for notifications", async () => {
    verify.mockResolvedValue("read");
    const r = await POST(req({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(r.status).toBe(200);
    expect((await r.json()).result.tools.length).toBeGreaterThan(0);
    expect((await POST(req({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
  });
  it("400 on garbage and 413 on an oversized body", async () => {
    verify.mockResolvedValue("read");
    expect((await POST(req("not json"))).status).toBe(400);
    expect((await POST(req("x".repeat(100_001)))).status).toBe(413);
  });
  it("GET is 405", async () => {
    expect((await GET()).status).toBe(405);
  });
});
