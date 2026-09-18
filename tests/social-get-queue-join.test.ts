import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies GET /api/social joins each draft against its publication_queue rows
// (content_type='social') via getQueueRowsForContent + summarizeQueueRows, so the
// dashboard can show a persistent "what will happen to this draft" state instead of
// the one-time approve-time alert/toast.

function mockHeavyImports() {
  vi.doMock("@/lib/facebook-client", () => ({ testConnection: vi.fn() }));
  vi.doMock("@/lib/instagram-client", () => ({ testConnection: vi.fn() }));
  vi.doMock("@/lib/social-publisher", () => ({
    publishDraftToChannel: vi.fn(),
    publishDraftToChannels: vi.fn(),
    draftToQueueItems: vi.fn(),
  }));
  vi.doMock("@/jobs/job4-social", () => ({
    triggerNewProduct: vi.fn(),
    triggerPriceDrop: vi.fn(),
    runStockHighlight: vi.fn(),
  }));
  vi.doMock("@/lib/llm-budget", () => ({ budgetedCreate: vi.fn() }));
}

function mockAuth(authed = true) {
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(authed),
    getSessionRole: vi.fn().mockResolvedValue("admin"),
  }));
}

function mockDatabase(over: Record<string, unknown> = {}) {
  const fns = {
    getFacebookDrafts: vi.fn().mockResolvedValue([]),
    getQueueRowsForContent: vi.fn().mockResolvedValue(new Map()),
    addToQueue: vi.fn(),
    getOccupiedQueueSlots: vi.fn(),
    cancelPendingQueueItems: vi.fn(),
    getSetting: vi.fn(),
    QueueSlotTakenError: class extends Error {},
    ...over,
  };
  vi.doMock("@/lib/database", () => fns);
  return fns;
}

function getReq() {
  return new Request("http://localhost/api/social");
}

async function callGet() {
  const mod = await import("@/app/api/social/route");
  return mod.GET(getReq());
}

const DRAFT_1 = { id: 1, status: "approved", postText: "A" };
const DRAFT_2 = { id: 2, status: "draft", postText: "B" };

function queueRow(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    contentType: "social",
    contentId: "1",
    platform: "both",
    payload: "{}",
    scheduledAt: "2026-09-20 15:00:00",
    status: "pending",
    error: null,
    createdAt: "2026-09-16 10:00:00",
    publishedAt: null,
    metadata: null,
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockHeavyImports();
});

describe("GET /api/social — queue join", () => {
  it("attaches queue.state='none' when a draft has no queue rows", async () => {
    mockAuth();
    mockDatabase({ getFacebookDrafts: vi.fn().mockResolvedValue([DRAFT_2]) });
    const body = await (await callGet()).json();
    expect(body.success).toBe(true);
    expect(body.data[0].queue).toEqual({
      state: "none",
      scheduledAt: null,
      publishedAt: null,
      error: null,
      counts: { pending: 0, publishing: 0, published: 0, failed: 0, cancelled: 0, draft: 0 },
      total: 0,
    });
  });

  it("attaches queue.state='scheduled' with the pending slot in unix seconds", async () => {
    mockAuth();
    const rows = new Map([["1", [queueRow()]]]);
    mockDatabase({
      getFacebookDrafts: vi.fn().mockResolvedValue([DRAFT_1]),
      getQueueRowsForContent: vi.fn().mockResolvedValue(rows),
    });
    const body = await (await callGet()).json();
    expect(body.data[0].queue.state).toBe("scheduled");
    // 2026-09-20 15:00:00 UTC
    expect(body.data[0].queue.scheduledAt).toBe(Math.floor(Date.parse("2026-09-20T15:00:00Z") / 1000));
  });

  it("attaches queue.state='published' with publishedAt in unix seconds", async () => {
    mockAuth();
    const rows = new Map([
      ["1", [queueRow({ status: "published", publishedAt: "2026-09-16 12:00:00" })]],
    ]);
    mockDatabase({
      getFacebookDrafts: vi.fn().mockResolvedValue([DRAFT_1]),
      getQueueRowsForContent: vi.fn().mockResolvedValue(rows),
    });
    const body = await (await callGet()).json();
    expect(body.data[0].queue.state).toBe("published");
    expect(body.data[0].queue.publishedAt).toBe(Math.floor(Date.parse("2026-09-16T12:00:00Z") / 1000));
  });

  it("attaches queue.state='failed' with the error message", async () => {
    mockAuth();
    const rows = new Map([["1", [queueRow({ status: "failed", error: "Facebook API rejected" })]]]);
    mockDatabase({
      getFacebookDrafts: vi.fn().mockResolvedValue([DRAFT_1]),
      getQueueRowsForContent: vi.fn().mockResolvedValue(rows),
    });
    const body = await (await callGet()).json();
    expect(body.data[0].queue.state).toBe("failed");
    expect(body.data[0].queue.error).toBe("Facebook API rejected");
  });

  it("a draft absent from the queue map gets state='none', not an exception", async () => {
    mockAuth();
    const rows = new Map([["999", [queueRow({ contentId: "999" })]]]); // unrelated draft
    mockDatabase({
      getFacebookDrafts: vi.fn().mockResolvedValue([DRAFT_1]),
      getQueueRowsForContent: vi.fn().mockResolvedValue(rows),
    });
    const body = await (await callGet()).json();
    expect(body.data[0].queue.state).toBe("none");
  });

  it("degrades to queue.state='none' for every draft, still HTTP 200, when the queue lookup throws", async () => {
    mockAuth();
    mockDatabase({
      getFacebookDrafts: vi.fn().mockResolvedValue([DRAFT_1, DRAFT_2]),
      getQueueRowsForContent: vi.fn().mockRejectedValue(new Error("db unreachable")),
    });
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data.every((d: { queue: { state: string } }) => d.queue.state === "none")).toBe(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth(false);
    mockDatabase();
    const res = await callGet();
    expect(res.status).toBe(401);
  });
});
