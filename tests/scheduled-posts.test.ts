/**
 * Tests for processScheduledDrafts() and the /api/cron/social-scheduled route.
 *
 * All imports use the real implementation of processScheduledDrafts — the DB layer
 * and social-publisher are mocked so no network calls are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module mocks (hoisted — must come before any imports that trigger module load) ──

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getFacebookDrafts: vi.fn(),
  claimFacebookDraft: vi.fn().mockResolvedValue(true),
  updateFacebookDraft: vi.fn().mockResolvedValue(undefined),
  getEligibleHighlightProduct: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  getProduct: vi.fn(),
  createNotification: vi.fn(),
  getAutopostCountToday: vi.fn(),
  incrementAutopostCountToday: vi.fn(),
}));

vi.mock("@/lib/social-publisher", () => ({
  publishDraftToChannels: vi.fn(),
}));

vi.mock("@/lib/image-composer", () => ({
  composeImage: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore", cronSecret: "test-cron-secret" },
  CLAUDE: { MODEL: "claude-test", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {
    FB_AMEUBLO: "fb_ameublo",
    FB_FURNISH: "fb_furnish",
    IG_AMEUBLO: "ig_ameublo",
    IG_FURNISH: "ig_furnish",
  },
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: vi.fn().mockResolvedValue(true),
}));

// ─── Real imports (after mocks are set up) ───────────────────────────────────────

import { processScheduledDrafts } from "@/jobs/job4-social";
import { getAllSettings, claimFacebookDraft, getFacebookDrafts, updateFacebookDraft } from "@/lib/database";
import { publishDraftToChannels } from "@/lib/social-publisher";

// ─── Fixtures ────────────────────────────────────────────────────────────────────

const NOW_S = Math.floor(Date.now() / 1000);
const PAST = NOW_S - 3600;
const FUTURE = NOW_S + 3600;

function makeDraft(overrides: Partial<{ id: number; scheduledAt: number | null; status: string }> = {}) {
  return {
    id: 100,
    sku: "TEST-SKU",
    status: "scheduled",
    scheduledAt: PAST,
    postText: "Texte FR",
    postTextEn: "EN text",
    imageUrls: ["https://img.example.com/1.jpg"],
    imageUrl: "https://img.example.com/1.jpg",
    imagePath: null,
    productImage: undefined,
    channels: {},
    createdAt: NOW_S - 7200,
    triggerType: "manual",
    language: "FR",
    oldPrice: null,
    newPrice: null,
    facebookPostId: null,
    publishedAt: null,
    hookId: null,
    ...overrides,
  };
}

const SETTINGS = { social_autopost_channels: "fb_ameublo" };
const SUCCESS = [{ channel: "fb_ameublo" as const, state: { status: "published" as const, publishedId: "12345", publishedAt: NOW_S } }];
const FAIL = [{ channel: "fb_ameublo" as const, state: { status: "error" as const, error: "Meta API 400" } }];

// ─── processScheduledDrafts unit tests ───────────────────────────────────────────

describe("processScheduledDrafts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);
    vi.mocked(claimFacebookDraft).mockResolvedValue(true);
    vi.mocked(updateFacebookDraft).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes drafts with scheduled_at <= NOW()", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(publishDraftToChannels).mockResolvedValue(SUCCESS);

    const result = await processScheduledDrafts();

    expect(publishDraftToChannels).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
  });

  it("skips drafts with scheduled_at > NOW()", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft({ scheduledAt: FUTURE })]);

    const result = await processScheduledDrafts();

    expect(publishDraftToChannels).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it("does NOT set status=failed when at least one channel succeeds", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(publishDraftToChannels).mockResolvedValue(SUCCESS);

    const result = await processScheduledDrafts();

    const failCalls = vi.mocked(updateFacebookDraft).mock.calls.filter(
      ([, fields]) => (fields as Record<string, unknown>).status === "failed"
    );
    expect(failCalls).toHaveLength(0);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("sets status=failed with draft id when ALL channels fail", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(publishDraftToChannels).mockResolvedValue(FAIL);

    const result = await processScheduledDrafts();

    const failCalls = vi.mocked(updateFacebookDraft).mock.calls.filter(
      ([, fields]) => (fields as Record<string, unknown>).status === "failed"
    );
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0][0]).toBe(100);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
  });

  it("skips draft when claimFacebookDraft returns false (already claimed)", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(claimFacebookDraft).mockResolvedValue(false);

    const result = await processScheduledDrafts();

    expect(publishDraftToChannels).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    expect(result.success).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("claimFacebookDraft called once per due draft", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft({ id: 1 }), makeDraft({ id: 2 })]);
    vi.mocked(claimFacebookDraft).mockResolvedValue(true);
    vi.mocked(publishDraftToChannels).mockResolvedValue(SUCCESS);

    await processScheduledDrafts();

    expect(claimFacebookDraft).toHaveBeenCalledTimes(2);
    expect(claimFacebookDraft).toHaveBeenCalledWith(1);
    expect(claimFacebookDraft).toHaveBeenCalledWith(2);
  });

  it("only publishes drafts where claim succeeds, skips others", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft({ id: 10 }), makeDraft({ id: 11 })]);
    vi.mocked(claimFacebookDraft)
      .mockResolvedValueOnce(true)   // draft 10: claimed
      .mockResolvedValueOnce(false); // draft 11: already taken by another instance
    vi.mocked(publishDraftToChannels).mockResolvedValue(SUCCESS);

    const result = await processScheduledDrafts();

    expect(publishDraftToChannels).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(2);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("returns correct stats shape { processed, success, failed }", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([]);

    const result = await processScheduledDrafts();

    expect(result).toMatchObject({ processed: 0, success: 0, failed: 0 });
    expect(typeof result.processed).toBe("number");
    expect(typeof result.success).toBe("number");
    expect(typeof result.failed).toBe("number");
  });
});

// ─── Route handler ────────────────────────────────────────────────────────────────

describe("GET /api/cron/social-scheduled — route handler", () => {
  it("returns 200 with stats JSON on valid Bearer token", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([]);
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);

    const { GET } = await import("@/app/api/cron/social-scheduled/route");

    const req = new Request("http://localhost/api/cron/social-scheduled", {
      headers: { authorization: "Bearer test-cron-secret" },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ processed: 0, success: 0, failed: 0 });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const { GET } = await import("@/app/api/cron/social-scheduled/route");
    const req = new Request("http://localhost/api/cron/social-scheduled");
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 when Bearer token is wrong", async () => {
    const { GET } = await import("@/app/api/cron/social-scheduled/route");
    const req = new Request("http://localhost/api/cron/social-scheduled", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/cron/social-scheduled — manual trigger", () => {
  it("returns 200 with stats JSON when authenticated", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([]);
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);

    const { isAuthenticated } = await import("@/lib/auth");
    vi.mocked(isAuthenticated).mockResolvedValue(true);

    const { POST } = await import("@/app/api/cron/social-scheduled/route");
    const req = new Request("http://localhost/api/cron/social-scheduled", { method: "POST" });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ processed: 0, success: 0, failed: 0 });
  });

  it("returns 401 when not authenticated", async () => {
    const { isAuthenticated } = await import("@/lib/auth");
    vi.mocked(isAuthenticated).mockResolvedValue(false);

    const { POST } = await import("@/app/api/cron/social-scheduled/route");
    const req = new Request("http://localhost/api/cron/social-scheduled", { method: "POST" });

    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe("processScheduledDrafts — edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(claimFacebookDraft).mockResolvedValue(true);
    vi.mocked(updateFacebookDraft).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks draft failed when no valid channels are configured", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(getAllSettings).mockResolvedValue({ social_autopost_channels: "not_a_real_channel" });

    const result = await processScheduledDrafts();

    const failCalls = vi.mocked(updateFacebookDraft).mock.calls.filter(
      ([, fields]) => (fields as Record<string, unknown>).status === "failed"
    );
    expect(failCalls).toHaveLength(1);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
  });

  it("marks draft failed on unexpected publishDraftToChannels error", async () => {
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);
    vi.mocked(publishDraftToChannels).mockRejectedValue(new Error("Network error"));

    const result = await processScheduledDrafts();

    const failCalls = vi.mocked(updateFacebookDraft).mock.calls.filter(
      ([, fields]) => (fields as Record<string, unknown>).status === "failed"
    );
    expect(failCalls).toHaveLength(1);
    expect(result.failed).toBe(1);
    expect(result.success).toBe(0);
  });

  it("counts success correctly when some channels fail but one succeeds", async () => {
    const PARTIAL = [
      { channel: "fb_ameublo" as const, state: { status: "published" as const, publishedId: "111", publishedAt: NOW_S } },
      { channel: "fb_furnish" as const, state: { status: "error" as const, error: "Meta 400" } },
    ];
    vi.mocked(getFacebookDrafts).mockResolvedValue([makeDraft()]);
    vi.mocked(getAllSettings).mockResolvedValue({ social_autopost_channels: "fb_ameublo,fb_furnish" });
    vi.mocked(publishDraftToChannels).mockResolvedValue(PARTIAL);

    const result = await processScheduledDrafts();

    expect(result.success).toBe(1);
    expect(result.failed).toBe(0);
  });
});
