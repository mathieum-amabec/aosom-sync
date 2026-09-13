import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression test for the "Consommation API" panel crashing the whole dashboard:
// budget=Infinity (the uncapped `maintenance` pool, see llm-budget.ts) survives a plain JS
// object fine, but NextResponse.json() runs JSON.stringify under the hood, and
// JSON.stringify(Infinity) silently produces `null` on the wire. The client
// (llm-usage-panel.tsx) called `p.budget.toLocaleString()` with no null guard, so every
// dashboard load threw "Cannot read properties of null (reading 'toLocaleString')" inside
// usage.pools.map() — an uncaught client exception that also tanked hydration (React #418).
vi.mock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/database", () => ({
  getLlmUsageWindow: vi.fn(),
}));
vi.mock("@/lib/llm-usage", () => ({
  estimateCostUsd: vi.fn().mockReturnValue(0),
  poolModel: vi.fn().mockReturnValue("test-model"),
  blendedRatePerMTok: vi.fn().mockReturnValue(0),
  ASSUMED_INPUT_SHARE: { assistant: 0.5, batch: 0.5, maintenance: 0.5 },
}));

import { GET } from "@/app/api/dashboard/llm-usage/route";
import { getLlmUsageWindow } from "@/lib/database";

const windowMock = vi.mocked(getLlmUsageWindow);

describe("GET /api/dashboard/llm-usage — uncapped pool serialization", () => {
  beforeEach(() => {
    windowMock.mockReset().mockResolvedValue([
      { day: "2026-09-13", assistant: 100, batch: 200, maintenance: 929 },
    ] as unknown as Awaited<ReturnType<typeof getLlmUsageWindow>>);
    // maintenance is uncapped by default in this test env (no LLM_MAINTENANCE_DAILY_BUDGET set).
    delete process.env.LLM_MAINTENANCE_DAILY_BUDGET;
  });

  it("never sends Infinity or NaN — the maintenance pool's budget is JSON null, not a crash waiting to happen", async () => {
    const res = await GET();
    const body = await res.json();
    const maintenance = body.pools.find((p: { pool: string }) => p.pool === "maintenance");

    expect(maintenance).toBeDefined();
    // The literal wire value: JSON has no Infinity, so this MUST be null, never a bare
    // number that happens to stringify to "null" would already be a contradiction — assert
    // the actual parsed type a real browser receives.
    expect(maintenance.budget).toBeNull();
    expect(Number.isFinite(maintenance.budget)).toBe(false);

    // Capped pools stay ordinary finite numbers — this must not regress into null too.
    const assistant = body.pools.find((p: { pool: string }) => p.pool === "assistant");
    expect(typeof assistant.budget).toBe("number");
    expect(Number.isFinite(assistant.budget)).toBe(true);
  });

  it("round-trips through JSON.stringify exactly like the real HTTP response would", async () => {
    const res = await GET();
    // Re-parse the raw serialized text (not res.json()'s already-parsed object) to prove
    // the wire format itself, the same bytes a real browser's fetch() would receive.
    const raw = JSON.stringify(await res.json());
    const reparsed = JSON.parse(raw);
    const maintenance = reparsed.pools.find((p: { pool: string }) => p.pool === "maintenance");
    expect(maintenance.budget).toBeNull();
  });
});
