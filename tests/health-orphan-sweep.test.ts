import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  getLatestSyncRun: vi.fn(),
  clearStaleLockIfNeeded: vi.fn(),
}));

const { GET } = await import("@/app/api/health/route");
const { getLatestSyncRun, clearStaleLockIfNeeded } = await import("@/lib/database");

const completedRun = () => ({
  id: "r1",
  startedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  status: "completed" as const,
  totalProducts: 100,
  created: 0,
  updated: 1,
  archived: 0,
  errors: 0,
  errorMessages: [],
});

describe("GET /api/health — orphan self-heal", () => {
  beforeEach(() => {
    vi.mocked(clearStaleLockIfNeeded).mockReset().mockResolvedValue(undefined);
    vi.mocked(getLatestSyncRun).mockReset().mockResolvedValue(completedRun());
  });

  it("sweeps stale running runs (15 min threshold) BEFORE reading the latest run", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(clearStaleLockIfNeeded).toHaveBeenCalledWith(15);
    // sweep must run before the status read so a freshly-cleared orphan is reflected
    const sweepOrder = vi.mocked(clearStaleLockIfNeeded).mock.invocationCallOrder[0];
    const readOrder = vi.mocked(getLatestSyncRun).mock.invocationCallOrder[0];
    expect(sweepOrder).toBeLessThan(readOrder);
    expect((await res.json()).status).toBe("ok");
  });

  it("stays healthy if the sweep throws (best-effort, non-fatal)", async () => {
    vi.mocked(clearStaleLockIfNeeded).mockRejectedValue(new Error("db blip"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db).toBe(true);
    expect(getLatestSyncRun).toHaveBeenCalled(); // read still happens after a swallowed sweep error
  });
});
