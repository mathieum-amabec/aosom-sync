import { describe, it, expect, vi } from "vitest";
import { handleMessage } from "@/lib/mcp/protocol";
import { TOOLS } from "@/lib/mcp/tools";

const fakeDb = (rows: unknown[] = []) => ({ execute: vi.fn(async () => ({ rows })) });
const call = (db: ReturnType<typeof fakeDb>, name: string, args: Record<string, unknown> = {}) =>
  handleMessage(db, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("MCP protocol", () => {
  it("initialize echoes the client protocol version and advertises tools", async () => {
    const r = await handleMessage(fakeDb(), { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect((r?.result as { protocolVersion: string; capabilities: object }).protocolVersion).toBe("2024-11-05");
    expect((r?.result as { capabilities: { tools: object } }).capabilities.tools).toEqual({});
  });
  it("notifications get no reply", async () => {
    expect(await handleMessage(fakeDb(), { method: "notifications/initialized" })).toBeNull();
  });
  it("tools/list exposes only the read-only tools", async () => {
    const r = await handleMessage(fakeDb(), { id: 2, method: "tools/list" });
    const names = (r?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(TOOLS.map((t) => t.name));
    expect(names.some((n) => /import$|publish|delete|update|write/.test(n.replace("import_queue", "")))).toBe(false);
  });
  it("unknown method / tool → JSON-RPC error", async () => {
    expect((await handleMessage(fakeDb(), { id: 3, method: "nope" }))?.error?.code).toBe(-32601);
    expect((await call(fakeDb(), "drop_everything"))?.error?.code).toBe(-32602);
  });
});

describe("MCP tools", () => {
  it("every statement a tool issues is a single SELECT", async () => {
    const db = fakeDb([]);
    for (const t of TOOLS) await t.handler(db, { query: "patio table", id: "X", limit: 999 });
    expect(db.execute.mock.calls.length).toBeGreaterThan(0);
    for (const [stmt] of db.execute.mock.calls as unknown as [{ sql: string }][]) {
      expect(stmt.sql).toMatch(/^\s*(select|with)\b/i);
      expect(stmt.sql.trim().replace(/;\s*$/, "")).not.toContain(";");
    }
  });
  it("caps limit at 25 and binds user text as args, never in the SQL", async () => {
    const db = fakeDb([]);
    await call(db, "search_products", { query: "x'; DROP TABLE products;--", supplier: "aosom", limit: 9999 });
    for (const [stmt] of db.execute.mock.calls as unknown as [{ sql: string; args: unknown[] }][]) {
      expect(stmt.sql).not.toMatch(/DROP TABLE/i);
      expect(stmt.sql).toMatch(/LIMIT 25\b/);
    }
  });
  it("falls back to one LIKE search when FTS finds nothing", async () => {
    const db = fakeDb([]);
    await call(db, "search_products", { query: "zzqxk", supplier: "aosom" });
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect((db.execute.mock.calls[1] as unknown as [{ sql: string }])[0].sql).toMatch(/name LIKE/);
  });
  it("tool errors are returned in-band (isError), not thrown", async () => {
    const db = { execute: vi.fn(async () => { throw new Error("BLOCKED reads"); }) };
    const r = await call(db as never, "catalog_overview");
    expect((r?.result as { isError: boolean }).isError).toBe(true);
  });
});
