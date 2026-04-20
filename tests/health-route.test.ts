import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  getSyncRuns: vi.fn().mockResolvedValue([]),
  getShopifyPushCheckpoint: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 29, retryAfterMs: 0 }),
}));

const { GET } = await import("@/app/api/sync/health/route");
const { checkRateLimit } = await import("@/lib/rate-limiter");

describe("GET /api/sync/health — rate limiter (GAP 2)", () => {
  beforeEach(() => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 29, retryAfterMs: 0 });
  });

  it("returns 200 when rate limit is not exceeded", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, remaining: 0, retryAfterMs: 5000 });
    const res = await GET();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
  });
});
