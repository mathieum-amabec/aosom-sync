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
import { getAllSettings, getFacebookDrafts, updateFacebookDraft } from "@/lib/database";
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

  it("claim via status=publishing prevents second invocation from picking up same draft", async () => {
    // First call sees the draft as scheduled; second call returns empty (draft is now publishing/published)
    vi.mocked(getFacebookDrafts)
      .mockResolvedValueOnce([makeDraft()])
      .mockResolvedValueOnce([]);
    vi.mocked(publishDraftToChannels).mockResolvedValue(SUCCESS);

    const [r1, r2] = await Promise.all([processScheduledDrafts(), processScheduledDrafts()]);

    expect(publishDraftToChannels).toHaveBeenCalledTimes(1);
    expect(r1.processed + r2.processed).toBe(1);
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
});
