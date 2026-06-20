import { describe, it, expect, vi, beforeEach } from "vitest";

// The route records its run via trackCron → recordCronRun (real cron-tracking, mocked DB).
vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));
vi.mock("@/lib/price-audit", () => ({
  runPriceAuditAndCorrect: vi.fn(),
  persistPriceAudit: vi.fn(),
}));
vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { GET } from "@/app/api/health/price-audit/route";
import { runPriceAuditAndCorrect, persistPriceAudit } from "@/lib/price-audit";
import { recordCronRun } from "@/lib/database";

const runMock = vi.mocked(runPriceAuditAndCorrect);
const persistMock = vi.mocked(persistPriceAudit);
const recMock = vi.mocked(recordCronRun);

const auth = (secret = "test-secret-123") =>
  new Request("https://app.test/api/health/price-audit", { headers: { Authorization: `Bearer ${secret}` } });

const RESULT = { total: 100, below_floor: 6, items: [], corrections: [], corrected: 2, failed: 1, deferred: 3 };

describe("GET /api/health/price-audit — cron_runs tracking", () => {
  beforeEach(() => {
    runMock.mockReset().mockResolvedValue(RESULT as unknown as Awaited<ReturnType<typeof runPriceAuditAndCorrect>>);
    persistMock.mockReset().mockResolvedValue(undefined);
    recMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 and records nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/health/price-audit"));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
    expect(recMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret", async () => {
    const res = await GET(auth("nope"));
    expect(res.status).toBe(401);
    expect(recMock).not.toHaveBeenCalled();
  });

  it("records success with corrected/failed/deferred/violations detail and returns the result", async () => {
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(persistMock).toHaveBeenCalledOnce();
    expect(recMock).toHaveBeenCalledWith("price-audit", "success", "corrected=2 failed=1 deferred=3 violations=6");
    const body = await res.json();
    expect(body).toMatchObject({ corrected: 2, failed: 1, deferred: 3, below_floor: 6 });
  });

  it("records an error run and returns 500 when the audit throws", async () => {
    runMock.mockRejectedValue(new Error("Shopify down"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
    expect(recMock).toHaveBeenCalledWith("price-audit", "error", "Shopify down");
  });
});
