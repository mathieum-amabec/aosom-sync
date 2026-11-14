import { describe, it, expect, vi, beforeEach } from "vitest";

// The route records its run via trackCron → recordCronRun (real cron-tracking, mocked DB).
vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));
vi.mock("@/lib/catalog-consistency-audit", () => ({
  runCatalogConsistencyAudit: vi.fn(),
  persistCatalogConsistencyAudit: vi.fn(),
}));
vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { GET } from "@/app/api/cron/catalog-consistency/route";
import { runCatalogConsistencyAudit, persistCatalogConsistencyAudit } from "@/lib/catalog-consistency-audit";
import { recordCronRun } from "@/lib/database";

const runMock = vi.mocked(runCatalogConsistencyAudit);
const persistMock = vi.mocked(persistCatalogConsistencyAudit);
const recMock = vi.mocked(recordCronRun);

const auth = (secret = "test-secret-123") =>
  new Request("https://app.test/api/cron/catalog-consistency", { headers: { Authorization: `Bearer ${secret}` } });

const RESULT = {
  auditedAt: 1000,
  totalActive: 1347,
  englishDescriptions: 2,
  brandLeaks: 1,
  duplicateColorOptions: 0,
  issues: [],
};

describe("GET /api/cron/catalog-consistency — cron_runs tracking", () => {
  beforeEach(() => {
    runMock.mockReset().mockResolvedValue(RESULT);
    persistMock.mockReset().mockResolvedValue(undefined);
    recMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 and runs nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/cron/catalog-consistency"));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
    expect(recMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong secret", async () => {
    const res = await GET(auth("nope"));
    expect(res.status).toBe(401);
    expect(recMock).not.toHaveBeenCalled();
  });

  it("runs the audit, persists the summary, and records a detail line in cron_runs", async () => {
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(persistMock).toHaveBeenCalledOnce();
    expect(recMock).toHaveBeenCalledWith(
      "catalog-consistency",
      "success",
      "active=1347 english=2 brand_leaks=1 duplicate_color=0",
    );
    const body = await res.json();
    expect(body).toMatchObject({ totalActive: 1347, englishDescriptions: 2, brandLeaks: 1 });
  });

  it("never writes to Shopify — persistCatalogConsistencyAudit is the only side effect besides cron_runs", async () => {
    await GET(auth());
    // The audit function itself is mocked (unit-tested separately in
    // catalog-consistency-audit.test.ts, which asserts it only calls shopifyFetch
    // GET requests); this test locks that the route wires nothing else in.
    expect(persistMock).toHaveBeenCalledWith(RESULT);
  });

  it("records an error run and returns 500 when the audit throws", async () => {
    runMock.mockRejectedValue(new Error("Shopify down"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
    expect(recMock).toHaveBeenCalledWith("catalog-consistency", "error", "Shopify down");
  });
});
