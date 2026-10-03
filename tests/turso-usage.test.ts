import { describe, it, expect, beforeEach, vi } from "vitest";
import { extractUsage, withUsageLogging, resetTursoUsageTotals, tursoUsageTotals } from "@/lib/turso-usage";

const reqBody = { requests: [{ type: "execute", stmt: { sql: "SELECT * FROM products WHERE name LIKE ?" } }, { type: "close" }] };
const resBody = {
  results: [
    { type: "ok", response: { type: "execute", result: { rows_read: 12000, rows_written: 0 } } },
    { type: "ok", response: { type: "close" } },
  ],
};

describe("extractUsage", () => {
  it("pairs each execute result with its SQL and skips results without rows_read", () => {
    expect(extractUsage(reqBody, resBody)).toEqual([{ sql: "SELECT * FROM products WHERE name LIKE ?", rowsRead: 12000, rowsWritten: 0 }]);
  });
  it("returns [] on garbage", () => {
    expect(extractUsage(null, null)).toEqual([]);
    expect(extractUsage({}, { results: "x" })).toEqual([]);
  });
});

describe("withUsageLogging", () => {
  beforeEach(() => resetTursoUsageTotals());

  it("logs heavy statements, accumulates totals and returns the response intact", async () => {
    const base = vi.fn(async () => new Response(JSON.stringify(resBody), { status: 200 }));
    const log = vi.fn();
    const f = withUsageLogging(base as unknown as typeof fetch, log);
    const res = await f("https://x/v2/pipeline", { method: "POST", body: JSON.stringify(reqBody) });
    expect((await res.json()).results).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("rows_read=12000");
    expect(tursoUsageTotals().rowsRead).toBe(12000);
  });

  it("reads the body of a Request object too", async () => {
    const base = vi.fn(async () => new Response(JSON.stringify(resBody), { status: 200 }));
    const log = vi.fn();
    const f = withUsageLogging(base as unknown as typeof fetch, log);
    await f(new Request("https://x/v2/pipeline", { method: "POST", body: JSON.stringify(reqBody) }));
    expect(log.mock.calls[0][0]).toContain("products WHERE name LIKE");
  });

  it("never throws on a non-JSON response", async () => {
    const base = vi.fn(async () => new Response("nope", { status: 200 }));
    const f = withUsageLogging(base as unknown as typeof fetch, vi.fn());
    await expect(f("https://x")).resolves.toBeInstanceOf(Response);
  });
});
