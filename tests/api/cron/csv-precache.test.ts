import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { cronSecret: "test-secret" },
  AOSOM: { CSV_URL: "https://aosom-cdn.example.com/feed.csv" },
}));

vi.mock("@/lib/database", () => ({
  getCachedBlobUrl: vi.fn().mockResolvedValue(null),
  upsertBlobCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vercel/blob", () => ({
  put: vi.fn(),
  del: vi.fn().mockResolvedValue(undefined),
}));

import { GET } from "@/app/api/cron/csv-precache/route";
import { put } from "@vercel/blob";
import { upsertBlobCache, getCachedBlobUrl } from "@/lib/database";

// 9,000 rows × ~1,300 bytes each ≈ 11.7 MB — passes both MIN_CSV_BYTES (10 MB) and MIN_CSV_ROWS (8 000)
const DATA_ROW = "SKU-001\tProduct Name\t" + "X".repeat(1280) + "\n";
const LARGE_CSV = "SKU\tName\n" + DATA_ROW.repeat(9_000);

function makeReq(auth?: string): Request {
  return new Request("http://localhost/api/cron/csv-precache", {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => LARGE_CSV }));
  vi.mocked(put).mockResolvedValue({ url: "https://blob.example.com/current.csv" } as ReturnType<typeof put> extends Promise<infer R> ? R : never);
});

describe("GET /api/cron/csv-precache", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong Bearer token", async () => {
    const res = await GET(makeReq("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("happy path: downloads, uploads, persists to DB", async () => {
    const res = await GET(makeReq("Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: { size_mb: string } };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(put).toHaveBeenCalledOnce();
    expect(upsertBlobCache).toHaveBeenCalledOnce();
    expect(upsertBlobCache).toHaveBeenCalledWith(expect.objectContaining({
      blob_url: "https://blob.example.com/current.csv",
      blob_key: "csv/aosom-feed/current.csv",
    }));
  });

  it("returns 500 when Aosom CDN fails, does not write to DB", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const res = await GET(makeReq("Bearer test-secret"));
    const body = await res.json() as { success: boolean; error: string };
    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(upsertBlobCache).not.toHaveBeenCalled();
  });

  it("returns 500 when CSV is suspiciously small, does not write to DB", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "tiny" }));
    const res = await GET(makeReq("Bearer test-secret"));
    const body = await res.json() as { success: boolean; error: string };
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/small/i);
    expect(upsertBlobCache).not.toHaveBeenCalled();
  });

  it("returns 500 when response is HTML (large error page), does not write to DB", async () => {
    // 11 MB HTML page — passes size floor but must be rejected as non-CSV
    const htmlResponse = "<!DOCTYPE html><html><body>Service Unavailable</body></html>\n" + "X".repeat(11 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => htmlResponse }));
    const res = await GET(makeReq("Bearer test-secret"));
    const body = await res.json() as { success: boolean; error: string };
    expect(res.status).toBe(500);
    expect(body.error).toMatch(/html/i);
    expect(upsertBlobCache).not.toHaveBeenCalled();
  });
});
