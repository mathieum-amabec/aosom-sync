import { describe, it, expect, vi, beforeEach } from "vitest";

// Set env before any module imports
process.env.CRON_SECRET = "test-cron-secret-for-vitest";

vi.mock("next/headers", () => ({
  cookies: () => ({ get: () => null }),
}));

const VALID_AUTH = "Bearer test-cron-secret-for-vitest";
const FETCH_RESULT = { raw_text: "csv,data\nrow1", bytes_size: 14, duration_ms: 100 };

function makeRequest(authHeader?: string): Request {
  return new Request("http://localhost/api/cron/precache-csv", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

describe("GET /api/cron/precache-csv", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("Test 1 — returns 401 without Bearer CRON_SECRET", async () => {
    vi.doMock("@/lib/csv-fetcher", () => ({ fetchAosomCatalogRaw: vi.fn() }));
    vi.doMock("@/lib/database", () => ({ upsertCachedCSV: vi.fn(), appendCacheLog: vi.fn() }));
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));

    const { GET } = await import("@/app/api/cron/precache-csv/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("Test 2 — successful fetch upserts cache and returns 200 with stats", async () => {
    const mockUpsert = vi.fn().mockResolvedValue(undefined);
    const mockLog = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/csv-fetcher", () => ({ fetchAosomCatalogRaw: vi.fn().mockResolvedValue(FETCH_RESULT) }));
    vi.doMock("@/lib/database", () => ({ upsertCachedCSV: mockUpsert, appendCacheLog: mockLog }));
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));

    const { GET } = await import("@/app/api/cron/precache-csv/route");
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.bytes_size).toBe(14);
    expect(body.data.fetch_duration_ms).toBe(100);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ raw_text: "csv,data\nrow1", bytes_size: 14, success: true })
    );
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("Test 3 — fetch failure skips upsert, logs error, returns 500", async () => {
    const mockUpsert = vi.fn();
    const mockLog = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/csv-fetcher", () => ({
      fetchAosomCatalogRaw: vi.fn().mockRejectedValue(new Error("CSV fetch exceeded 540s — likely Aosom CDN slow window")),
    }));
    vi.doMock("@/lib/database", () => ({ upsertCachedCSV: mockUpsert, appendCacheLog: mockLog }));
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));

    const { GET } = await import("@/app/api/cron/precache-csv/route");
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("PRECACHE_FAILED");

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it("Test 4 — DB upsert failure after successful fetch returns 500", async () => {
    const mockLog = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/csv-fetcher", () => ({ fetchAosomCatalogRaw: vi.fn().mockResolvedValue(FETCH_RESULT) }));
    vi.doMock("@/lib/database", () => ({
      upsertCachedCSV: vi.fn().mockRejectedValue(new Error("Turso connection failed")),
      appendCacheLog: mockLog,
    }));
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));

    const { GET } = await import("@/app/api/cron/precache-csv/route");
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("PRECACHE_FAILED");
  });

  it("Test 5 — graceful degradation when appendCacheLog itself fails on fetch error", async () => {
    vi.doMock("@/lib/csv-fetcher", () => ({
      fetchAosomCatalogRaw: vi.fn().mockRejectedValue(new Error("network timeout")),
    }));
    vi.doMock("@/lib/database", () => ({
      upsertCachedCSV: vi.fn(),
      appendCacheLog: vi.fn().mockRejectedValue(new Error("DB unavailable")),
    }));
    vi.doMock("@/lib/auth", () => ({ isAuthenticated: vi.fn().mockResolvedValue(false) }));

    const { GET } = await import("@/app/api/cron/precache-csv/route");
    // Should not throw — secondary failure is swallowed
    const res = await GET(makeRequest(VALID_AUTH));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
