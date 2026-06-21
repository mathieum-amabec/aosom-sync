import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));
vi.mock("@/lib/stale-catalog", () => ({ runStaleCatalogDraft: vi.fn() }));
vi.mock("@/lib/database", () => ({ recordCronRun: vi.fn() }));

import { GET } from "@/app/api/cron/stale-catalog/route";
import { runStaleCatalogDraft } from "@/lib/stale-catalog";
import { recordCronRun } from "@/lib/database";

const runMock = vi.mocked(runStaleCatalogDraft);
const recMock = vi.mocked(recordCronRun);
const auth = (s = "test-secret-123") =>
  new Request("https://app.test/api/cron/stale-catalog", { headers: { Authorization: `Bearer ${s}` } });

describe("GET /api/cron/stale-catalog", () => {
  beforeEach(() => {
    runMock.mockReset().mockResolvedValue({ stale: 106, drafted: 103, skipped: 1, failed: 2 });
    recMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 and does nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/cron/stale-catalog"));
    expect(res.status).toBe(401);
    expect(runMock).not.toHaveBeenCalled();
    expect(recMock).not.toHaveBeenCalled();
  });

  it("records 'stale=N drafted=X skipped=Y failed=Z' and returns the result", async () => {
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(recMock).toHaveBeenCalledWith("stale-catalog", "success", "stale=106 drafted=103 skipped=1 failed=2");
    expect(await res.json()).toEqual({ success: true, stale: 106, drafted: 103, skipped: 1, failed: 2 });
  });

  it("records an error run and returns 500 when the draft pass throws", async () => {
    runMock.mockRejectedValue(new Error("Shopify down"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
    expect(recMock).toHaveBeenCalledWith("stale-catalog", "error", "Shopify down");
  });
});
