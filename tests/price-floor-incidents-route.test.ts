import { describe, it, expect, vi, beforeEach } from "vitest";

// TASK 3: /api/price-floor-incidents surfaces the unified below-floor correction
// history (database.ts's price_floor_incidents table) to the dashboard panel.
vi.mock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/database", () => ({
  getPriceFloorIncidents: vi.fn(),
  countPriceFloorIncidents: vi.fn(),
}));

import { GET } from "@/app/api/price-floor-incidents/route";
import { isAuthenticated } from "@/lib/auth";
import { getPriceFloorIncidents, countPriceFloorIncidents } from "@/lib/database";

const authMock = vi.mocked(isAuthenticated);
const incidentsMock = vi.mocked(getPriceFloorIncidents);
const countMock = vi.mocked(countPriceFloorIncidents);

describe("GET /api/price-floor-incidents", () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue(true);
    incidentsMock.mockReset();
    countMock.mockReset();
  });

  it("returns 401 when not authenticated, without touching the database", async () => {
    authMock.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(incidentsMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("returns the recent incidents plus lifetime and 30-day counts", async () => {
    incidentsMock.mockResolvedValue([
      { id: 2, sku: "842-375V00CG", oldPrice: 148.99, newPrice: 157.99, source: "price_reconcile", detectedAt: 1_790_000_000 },
      { id: 1, sku: "83B-406V80GY", oldPrice: 478.99, newPrice: 494.99, source: "price_audit", detectedAt: 1_789_900_000 },
    ]);
    // Lifetime count, then the 30-day-window count (call order matches the route's
    // Promise.all([incidents, countPriceFloorIncidents(), countPriceFloorIncidents(cutoff)])).
    countMock.mockResolvedValueOnce(42).mockResolvedValueOnce(7);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.incidents).toHaveLength(2);
    expect(body.incidents[0].sku).toBe("842-375V00CG");
    expect(body.total).toBe(42);
    expect(body.last30Days).toBe(7);
  });

  it("passes a cutoff roughly 30 days before now to the trailing-window count", async () => {
    incidentsMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    const before = Math.floor(Date.now() / 1000);
    await GET();

    const cutoffArg = countMock.mock.calls.find((c) => c.length > 0)?.[0] as number | undefined;
    expect(cutoffArg).toBeDefined();
    const expectedCutoff = before - 30 * 24 * 3600;
    // Allow a few seconds of test-execution drift.
    expect(Math.abs((cutoffArg as number) - expectedCutoff)).toBeLessThan(5);
  });

  it("returns 500 (not a raw throw) when the database read fails", async () => {
    incidentsMock.mockRejectedValue(new Error("turso down"));
    countMock.mockResolvedValue(0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET();

    expect(res.status).toBe(500);
    errorSpy.mockRestore();
  });

  it("empty history returns an empty list with zero counts, not an error", async () => {
    incidentsMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.incidents).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.last30Days).toBe(0);
  });
});
