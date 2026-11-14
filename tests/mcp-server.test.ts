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
  it("tools/list only shows the tools the permissions allow", async () => {
    const list = async (scopes: string[]) => ((await handleMessage(fakeDb(), { id: 2, method: "tools/list" }, { scopes: new Set(scopes) as never }))?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    const readOnly = await list(["read"]);
    expect(readOnly).toEqual(TOOLS.filter((t) => t.scope === "read").map((t) => t.name));
    expect(readOnly).not.toContain("best_sellers");
    expect(await list(["read", "analytics"])).toEqual(TOOLS.map((t) => t.name));
    const names = readOnly;
    expect(names.some((n) => /import$|publish|delete|update|write/.test(n.replace("import_queue", "")))).toBe(false);
  });
  it("calling a tool outside the granted permissions is refused", async () => {
    const db = fakeDb();
    const denied = await handleMessage(db, { id: 5, method: "tools/call", params: { name: "best_sellers", arguments: {} } }, { scopes: new Set(["read"]) as never });
    expect(denied?.error?.code).toBe(-32602);
    expect(db.execute).not.toHaveBeenCalled();
    const allowed = await handleMessage(db, { id: 6, method: "tools/call", params: { name: "best_sellers", arguments: {} } }, { scopes: new Set(["read", "analytics"]) as never });
    expect(allowed?.error).toBeUndefined();
  });
  it("unknown method / tool → JSON-RPC error", async () => {
    expect((await handleMessage(fakeDb(), { id: 3, method: "nope" }))?.error?.code).toBe(-32601);
    expect((await call(fakeDb(), "drop_everything"))?.error?.code).toBe(-32602);
  });

  describe("morning_report tool", () => {
    const stored = JSON.stringify({ date: "2026-10-07", subject: "Rapport du matin — mercredi 7 octobre", text: "Résultats des photos : 12 vues", missingSections: ["Publicités Meta"], generatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const out = (r: Awaited<ReturnType<typeof call>>) => JSON.parse((r?.result as { content: { text: string }[] }).content[0].text);

    it("is a read-only tool, available with the basic permission", () => {
      expect(TOOLS.find((t) => t.name === "morning_report")?.scope).toBe("read");
    });
    it("returns the stored report with its age and missing sections", async () => {
      const o = out(await call(fakeDb([{ value: stored }]), "morning_report"));
      expect(o).toMatchObject({ available: true, date: "2026-10-07", age_hours: 3, missing_sections: ["Publicités Meta"] });
      expect(o.text).toContain("12 vues");
    });
    it("runs a single read-only SELECT on the settings key", async () => {
      const db = fakeDb([{ value: stored }]);
      await call(db, "morning_report");
      expect(db.execute).toHaveBeenCalledTimes(1);
      const stmt = (db.execute.mock.calls[0] as unknown as [{ sql: string; args: string[] }])[0];
      expect(stmt.sql).toMatch(/^\s*select/i);
      expect(stmt.args).toEqual(["morning_report_last"]);
    });
    it("says so plainly when no report is stored yet, or the value is unreadable", async () => {
      expect(out(await call(fakeDb([]), "morning_report")).available).toBe(false);
      expect(out(await call(fakeDb([{ value: "not json" }]), "morning_report")).available).toBe(false);
    });
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
