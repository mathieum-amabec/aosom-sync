import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── GET /api/cron/social (stock_highlight) ──────────────────────────────────

function makeRequest(cronSecret = "test-secret-123"): Request {
  return new Request("https://aosom-sync.vercel.app/api/cron/social", {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
}

describe("GET /api/cron/social — stock_highlight", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret-123";
  });

  it("returns 401 for missing auth", async () => {
    vi.doMock("@/jobs/job4-social", () => ({ triggerStockHighlight: vi.fn() }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(new Request("https://aosom-sync.vercel.app/api/cron/social"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with draftId when a draft is generated", async () => {
    const trigger = vi.fn().mockResolvedValue({ draftId: 42, imageUrls: ["a", "b"] });
    vi.doMock("@/jobs/job4-social", () => ({ triggerStockHighlight: trigger }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.draftId).toBe(42);
    expect(body.photos).toBe(2);
    expect(body.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("returns 200 skipped when no eligible product", async () => {
    vi.doMock("@/jobs/job4-social", () => ({ triggerStockHighlight: vi.fn().mockResolvedValue(null) }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.skipped).toMatch(/no eligible product/);
  });

  it("returns 500 when triggerStockHighlight throws", async () => {
    vi.doMock("@/jobs/job4-social", () => ({
      triggerStockHighlight: vi.fn().mockRejectedValue(new Error("Anthropic timeout")),
    }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Anthropic timeout/);
  });
});
