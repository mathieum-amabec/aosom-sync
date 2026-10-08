import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CRON_SECRET = "test-cron-secret";
const AUTH = { authorization: "Bearer test-cron-secret" };

const state = vi.hoisted(() => ({ paused: false, recorded: [] as Array<{ name: string; status: string; detail?: string }> }));
vi.mock("@/lib/automation-controls", () => ({ isPublisherPaused: vi.fn(async () => state.paused) }));
vi.mock("@/lib/database", () => ({
  recordCronRun: vi.fn(async (name: string, status: string, detail?: string) => { state.recorded.push({ name, status, detail }); }),
}));
const drain = vi.hoisted(() => ({ drainPublisherQueue: vi.fn() }));
vi.mock("@/lib/queue-publisher", () => ({ drainPublisherQueue: drain.drainPublisherQueue }));
vi.mock("@/lib/auth", () => ({ isAuthenticated: vi.fn(async () => true) }));

import { GET } from "@/app/api/cron/publisher/route";

beforeEach(() => {
  state.paused = false;
  state.recorded = [];
  drain.drainPublisherQueue.mockReset().mockResolvedValue({ processed: 2, published: 2, failed: 0, skipped: 0, deferred: 0, reclaimed: 0, outcomes: [] });
});

describe("GET /api/cron/publisher with the operator switch", () => {
  it("drains the queue when not paused", async () => {
    const res = await GET(new Request("http://x", { headers: AUTH }));
    expect(res.status).toBe(200);
    expect(drain.drainPublisherQueue).toHaveBeenCalledOnce();
    expect(state.recorded[0]).toMatchObject({ name: "publisher", status: "success", detail: "2 due, 2 published, 0 failed" });
  });

  it("publishes nothing while paused, and says so in the cron log", async () => {
    state.paused = true;
    const res = await GET(new Request("http://x", { headers: AUTH }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.paused).toBe(true);
    expect(drain.drainPublisherQueue).not.toHaveBeenCalled();
    expect(state.recorded[0].detail).toContain("EN PAUSE");
  });

  it("still rejects a call without the cron secret", async () => {
    expect((await GET(new Request("http://x"))).status).toBe(401);
  });
});
