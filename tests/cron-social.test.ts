import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── GET /api/cron/social (daily social batch) ───────────────────────────────

function makeRequest(cronSecret = "test-secret-123"): Request {
  return new Request("https://aosom-sync.vercel.app/api/cron/social", {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
}

describe("GET /api/cron/social — daily social batch", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = "test-secret-123";
  });

  it("returns 401 for missing auth", async () => {
    vi.doMock("@/jobs/job4-social", () => ({ generateSocialBatch: vi.fn(), SOCIAL_DAILY_BATCH: 3 }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(new Request("https://aosom-sync.vercel.app/api/cron/social"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with count + draftIds when drafts are generated", async () => {
    const batch = vi.fn().mockResolvedValue([
      { draftId: 42, imageUrls: ["a"] },
      { draftId: 43, imageUrls: ["b"] },
      { draftId: 44, imageUrls: ["c"] },
    ]);
    vi.doMock("@/jobs/job4-social", () => ({ generateSocialBatch: batch, SOCIAL_DAILY_BATCH: 3 }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(3);
    expect(body.draftIds).toEqual([42, 43, 44]);
    expect(body.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(batch).toHaveBeenCalledWith(3);
  });

  it("returns 200 skipped when no eligible product", async () => {
    vi.doMock("@/jobs/job4-social", () => ({ generateSocialBatch: vi.fn().mockResolvedValue([]), SOCIAL_DAILY_BATCH: 3 }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.skipped).toMatch(/no eligible/);
  });

  it("returns 500 when generateSocialBatch throws", async () => {
    vi.doMock("@/jobs/job4-social", () => ({
      generateSocialBatch: vi.fn().mockRejectedValue(new Error("Anthropic timeout")),
      SOCIAL_DAILY_BATCH: 3,
    }));
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Anthropic timeout/);
  });
});
