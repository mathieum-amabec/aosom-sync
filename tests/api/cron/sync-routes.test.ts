/**
 * Tests for the Phase 1 cron route handlers:
 *   GET /api/cron/sync         — calls runSyncFull (Fluid Compute orchestrator, v0.4.0.0+)
 *   GET /api/cron/sync-refresh — calls runSyncRefreshChunk (manual fallback only)
 *   GET /api/cron/sync-finalize — calls runSyncFinalize (manual fallback only)
 *
 * Each route shares the same pattern:
 *   - 401 when Authorization header is missing
 *   - 401 when Bearer token is wrong
 *   - 200 + { success: true, data } on success
 *   - 500 + { success: false, error } when the job throws
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({
  env: { cronSecret: "test-secret" },
}));

vi.mock("@/jobs/job1-sync", () => ({
  runSyncFull: vi.fn(),
  runSyncInit: vi.fn(),
  runSyncRefreshChunk: vi.fn(),
  runSyncFinalize: vi.fn(),
}));

import { GET as getSyncInit } from "@/app/api/cron/sync/route";
import { GET as getSyncRefresh } from "@/app/api/cron/sync-refresh/route";
import { GET as getSyncFinalize } from "@/app/api/cron/sync-finalize/route";
import { runSyncFull, runSyncInit, runSyncRefreshChunk, runSyncFinalize } from "@/jobs/job1-sync";

function makeReq(url: string, auth?: string): Request {
  return new Request(`http://localhost${url}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── GET /api/cron/sync (Fluid Compute orchestrator, v0.4.0.0+) ──────────────

describe("GET /api/cron/sync", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await getSyncInit(makeReq("/api/cron/sync"));
    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Unauthorized");
    expect(runSyncFull).not.toHaveBeenCalled();
  });

  it("returns 401 with wrong Bearer token", async () => {
    const res = await getSyncInit(makeReq("/api/cron/sync", "Bearer wrong-secret"));
    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(false);
    expect(runSyncFull).not.toHaveBeenCalled();
  });

  it("returns 200 with job result on success", async () => {
    const jobResult = { skipped: false, totalChunks: 3, chunksProcessed: 3, totalProducts: 7500 };
    vi.mocked(runSyncFull).mockResolvedValueOnce(jobResult);

    const res = await getSyncInit(makeReq("/api/cron/sync", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: typeof jobResult };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(jobResult);
    expect(runSyncFull).toHaveBeenCalledOnce();
  });

  it("returns 200 with skipped=true when already finalized today (idempotent retry)", async () => {
    const jobResult = { skipped: true, reason: "Already finalized today", totalChunks: 3, chunksProcessed: 3, totalProducts: 7500 };
    vi.mocked(runSyncFull).mockResolvedValueOnce(jobResult);

    const res = await getSyncInit(makeReq("/api/cron/sync", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: typeof jobResult };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe(true);
  });

  it("returns 500 when runSyncFull throws", async () => {
    vi.mocked(runSyncFull).mockRejectedValueOnce(new Error("CSV unreachable"));

    const res = await getSyncInit(makeReq("/api/cron/sync", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; error: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Sync full failed");
  });
});

// ─── GET /api/cron/sync-refresh (Phase 1 refresh chunk) ──────────────────────

describe("GET /api/cron/sync-refresh", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await getSyncRefresh(makeReq("/api/cron/sync-refresh"));
    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Unauthorized");
    expect(runSyncRefreshChunk).not.toHaveBeenCalled();
  });

  it("returns 401 with wrong Bearer token", async () => {
    const res = await getSyncRefresh(makeReq("/api/cron/sync-refresh", "Bearer bad-token"));
    expect(res.status).toBe(401);
    expect(runSyncRefreshChunk).not.toHaveBeenCalled();
  });

  it("returns 200 with chunk result when work is pending", async () => {
    const jobResult = { chunksProcessed: 1, totalChunks: 3, refreshDone: false, skipped: false };
    vi.mocked(runSyncRefreshChunk).mockResolvedValueOnce(jobResult);

    const res = await getSyncRefresh(makeReq("/api/cron/sync-refresh", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: typeof jobResult };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(jobResult);
    expect(runSyncRefreshChunk).toHaveBeenCalledOnce();
  });

  it("returns 200 with skipped=true when no pending refresh work", async () => {
    const jobResult = { chunksProcessed: 0, totalChunks: 0, refreshDone: true, skipped: true };
    vi.mocked(runSyncRefreshChunk).mockResolvedValueOnce(jobResult);

    const res = await getSyncRefresh(makeReq("/api/cron/sync-refresh", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: typeof jobResult };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe(true);
  });

  it("returns 200 with refreshDone=true when last chunk is processed", async () => {
    const jobResult = { chunksProcessed: 3, totalChunks: 3, refreshDone: true, skipped: false };
    vi.mocked(runSyncRefreshChunk).mockResolvedValueOnce(jobResult);

    const res = await getSyncRefresh(makeReq("/api/cron/sync-refresh", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: typeof jobResult };

    expect(res.status).toBe(200);
    expect(body.data.refreshDone).toBe(true);
  });

  it("returns 500 when runSyncRefreshChunk throws", async () => {
    vi.mocked(runSyncRefreshChunk).mockRejectedValueOnce(new Error("DB timeout"));

    const res = await getSyncRefresh(makeReq("/api/cron/sync-refresh", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; error: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Sync refresh failed");
  });
});

// ─── GET /api/cron/sync-finalize (Phase 1 finalize) ──────────────────────────

describe("GET /api/cron/sync-finalize", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await getSyncFinalize(makeReq("/api/cron/sync-finalize"));
    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Unauthorized");
    expect(runSyncFinalize).not.toHaveBeenCalled();
  });

  it("returns 401 with wrong Bearer token", async () => {
    const res = await getSyncFinalize(makeReq("/api/cron/sync-finalize", "Bearer wrong"));
    expect(res.status).toBe(401);
    expect(runSyncFinalize).not.toHaveBeenCalled();
  });

  it("returns 200 with skipped=false when finalize runs", async () => {
    vi.mocked(runSyncFinalize).mockResolvedValueOnce({ skipped: false });

    const res = await getSyncFinalize(makeReq("/api/cron/sync-finalize", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: { skipped: boolean } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe(false);
    expect(runSyncFinalize).toHaveBeenCalledOnce();
  });

  it("returns 200 with skipped=true when refresh not yet complete", async () => {
    vi.mocked(runSyncFinalize).mockResolvedValueOnce({ skipped: true });

    const res = await getSyncFinalize(makeReq("/api/cron/sync-finalize", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; data: { skipped: boolean } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe(true);
  });

  it("returns 500 when runSyncFinalize throws", async () => {
    vi.mocked(runSyncFinalize).mockRejectedValueOnce(new Error("rebuildCounts exploded"));

    const res = await getSyncFinalize(makeReq("/api/cron/sync-finalize", "Bearer test-secret"));
    const body = await res.json() as { success: boolean; error: string };

    expect(res.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Sync finalize failed");
  });
});
