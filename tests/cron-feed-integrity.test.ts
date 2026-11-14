import { describe, it, expect, vi, beforeEach } from "vitest";

// Same pattern as cron-catalog-consistency.test.ts: real trackCron, mocked DB + config.
vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-cron-secret" } }));
const runFeedIntegrityAudit = vi.fn();
const persistFeedIntegrityAudit = vi.fn();
vi.mock("@/lib/feed-integrity-audit", () => ({
  runFeedIntegrityAudit, persistFeedIntegrityAudit, productionFeedIntegrityDeps: { marker: "prod" },
}));
const recordCronRun = vi.fn();
vi.mock("@/lib/database", () => ({ recordCronRun }));

const { GET } = await import("@/app/api/cron/feed-integrity/route");
const req = (auth?: string) =>
  new Request("https://aosom-sync.vercel.app/api/cron/feed-integrity", { headers: auth ? { authorization: auth } : {} });

const RESULT = {
  auditedAt: 1, ok: false, reasons: ["le flux Google publié est vide"],
  logic: { items: 2519, multiItems: 1681 }, served: { items: 0, drifted: 0 }, landing: [{ outcome: "ok" }],
};

beforeEach(() => {
  runFeedIntegrityAudit.mockReset().mockResolvedValue(RESULT);
  persistFeedIntegrityAudit.mockReset().mockResolvedValue(undefined);
  recordCronRun.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/cron/feed-integrity", () => {
  it("rejects a request without the CRON_SECRET bearer", async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(runFeedIntegrityAudit).not.toHaveBeenCalled();
  });

  it("runs the audit on the production deps, persists it and records the run in cron_runs", async () => {
    const res = await GET(req("Bearer test-cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, reasons: ["le flux Google publié est vide"] });
    expect(runFeedIntegrityAudit).toHaveBeenCalledWith({ marker: "prod" });
    expect(persistFeedIntegrityAudit).toHaveBeenCalledWith(RESULT);
    expect(recordCronRun).toHaveBeenCalledWith(
      "feed-integrity",
      "success",
      "ALERT items=2519 multi=1681 served=0 drift=0 landing_ok=1/1 — le flux Google publié est vide",
    );
  });

  it("a crashed audit is a 500 and an 'error' cron run (which the guard verdict turns red)", async () => {
    runFeedIntegrityAudit.mockRejectedValueOnce(new Error("flux Google publié injoignable"));
    const res = await GET(req("Bearer test-cron-secret"));
    expect(res.status).toBe(500);
    expect(persistFeedIntegrityAudit).not.toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith("feed-integrity", "error", expect.stringContaining("flux Google publié injoignable"));
  });
});
