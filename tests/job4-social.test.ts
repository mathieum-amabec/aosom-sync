import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { triggerStockHighlight, triggerNewProduct, triggerPriceDrop } from "@/jobs/job4-social";

// ─── Mock factories ───────────────────────────────────────────────────

// vi.hoisted ensures mockCreate is defined before vi.mock() factories run.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getEligibleHighlightCandidates: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  getProduct: vi.fn(),
  createNotification: vi.fn(),
  getAutopostCountToday: vi.fn(),
  incrementAutopostCountToday: vi.fn(),
}));

// Lifestyle gate: default verified so triggers proceed; individual tests can
// override to exercise the skip path.
vi.mock("@/lib/selectors/shopify-images", () => ({
  resolveLifestyle: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore" },
  CLAUDE: { MODEL: "claude-test", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {},
}));

vi.mock("@/lib/social-publisher", () => ({
  publishDraftToChannels: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────

import {
  getAllSettings,
  getEligibleHighlightCandidates,
  getProduct,
  createFacebookDraft,
  markProductPosted,
} from "@/lib/database";
import { resolveLifestyle } from "@/lib/selectors/shopify-images";

const SETTINGS = {
  social_min_days_between_reposts: "30",
  prompt_highlight_fr: "Post FR pour {product_name}",
  prompt_highlight_en: "Post EN for {product_name}",
  social_hashtags_fr: "#test",
  social_hashtags_en: "#test",
};

const PRODUCT = {
  sku: "TEST-001",
  name: "Test Product",
  price: 99.99,
  qty: 5,
  shopify_product_id: "111",
  image1: "https://cdn.example.com/img.jpg",
};

const LIFESTYLE_VERIFIED = {
  verified: true,
  primaryImageUrl: "https://cdn.shopify.com/s/files/lifestyle.jpg",
} as const;

const DRAFT_ID = 42;

function makeMsg(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function makeTimeout() {
  // Use the real SDK error class so tests match what AbortSignal.timeout() causes
  // in production (SDK wraps it into APIUserAbortError, not a raw "TimeoutError").
  return new Anthropic.APIUserAbortError();
}

// ─── raw lifestyle image (no branding/compositor) ─────────────────────
//
// Job 4 posts the product's clean Shopify position-1 lifestyle photo RAW: the
// draft's imageUrls is exactly [primaryImageUrl] — never a composed
// /api/image-preview URL, and never a white-bg / gallery image. When the product
// is not lifestyle-verified (or no clean photo resolves), the trigger skips.

describe("raw lifestyle image", () => {
  const LIFESTYLE_URL = "https://cdn.shopify.com/s/files/lifestyle.jpg";

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue({
      ...SETTINGS,
      prompt_new_product_fr: "Post FR {product_name}",
      prompt_new_product_en: "Post EN {product_name}",
      prompt_price_drop_fr: "Baisse {product_name}",
      prompt_price_drop_en: "Drop {product_name}",
    });
    vi.mocked(getEligibleHighlightCandidates).mockResolvedValue([PRODUCT] as never);
    vi.mocked(getProduct).mockResolvedValue(PRODUCT as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(DRAFT_ID);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    vi.mocked(resolveLifestyle).mockResolvedValue({ ...LIFESTYLE_VERIFIED });
    mockCreate.mockResolvedValue(makeMsg("text"));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["new_product", () => triggerNewProduct("TEST-001")],
    ["price_drop", () => triggerPriceDrop("TEST-001", 100, 80)],
    ["stock_highlight", () => triggerStockHighlight()],
  ] as const)("%s: posts the raw lifestyle URL, one image, no compositor", async (_name, run) => {
    const result = await run();
    expect(result).not.toBeNull();
    expect(result!.imageUrls).toEqual([LIFESTYLE_URL]);
    expect(result!.imageUrl).toBe(LIFESTYLE_URL);
    expect(result!.imagePath).toBe(LIFESTYLE_URL);
    // Never a composed /api/image-preview URL.
    expect(result!.imageUrls.some((u) => u.includes("/api/image-preview"))).toBe(false);

    const draftArg = vi.mocked(createFacebookDraft).mock.calls[0][0];
    expect(draftArg.imageUrls).toEqual([LIFESTYLE_URL]);
  });

  it.each([
    ["new_product", () => triggerNewProduct("TEST-001")],
    ["price_drop", () => triggerPriceDrop("TEST-001", 100, 80)],
    ["stock_highlight", () => triggerStockHighlight()],
  ] as const)("%s: skips (returns null, no draft) when not lifestyle-verified", async (_name, run) => {
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null });
    const result = await run();
    expect(result).toBeNull();
    expect(createFacebookDraft).not.toHaveBeenCalled();
  });
});

// ─── triggerStockHighlight — Anthropic timeout handling ───────────────

describe("triggerStockHighlight — Anthropic timeout handling", () => {
  beforeEach(() => {
    // Clear call history before every test so counts don't bleed across.
    vi.resetAllMocks();

    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);
    vi.mocked(getEligibleHighlightCandidates).mockResolvedValue([PRODUCT] as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(DRAFT_ID);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    vi.mocked(resolveLifestyle).mockResolvedValue({ ...LIFESTYLE_VERIFIED });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Scenario 1: happy path ──────────────────────────────────────────

  it("happy path: both parallel calls complete → draft created", async () => {
    mockCreate
      .mockResolvedValueOnce(makeMsg("Texte FR généré"))   // fr
      .mockResolvedValueOnce(makeMsg("Generated EN text")); // en

    const result = await triggerStockHighlight();

    expect(result?.draftId).toBe(DRAFT_ID);
    expect(result?.postText).toBe("Texte FR généré");
    expect(result?.postTextEn).toBe("Generated EN text");
    expect(createFacebookDraft).toHaveBeenCalledOnce();
    expect(markProductPosted).toHaveBeenCalledWith("TEST-001");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  // ── Scenarios 2 + 3: retry delay is 10ms in test env (NODE_ENV=test) ──
  // No fake timers needed — real timers at 10ms are fast enough for unit tests.

  it("timeout on first attempt, retry succeeds → draft created + warn logged", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockCreate
      // Attempt 1: fr rejects, en resolves (ignored by Promise.all once fr rejects)
      .mockRejectedValueOnce(makeTimeout())
      .mockResolvedValueOnce(makeMsg("(ignored)"))
      // Attempt 2 (retry): both succeed
      .mockResolvedValueOnce(makeMsg("Texte FR retry"))
      .mockResolvedValueOnce(makeMsg("Text EN retry"));

    const result = await triggerStockHighlight();

    expect(result?.draftId).toBe(DRAFT_ID);
    expect(result?.postText).toBe("Texte FR retry");
    expect(result?.postTextEn).toBe("Text EN retry");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("anthropic timeout, retrying"),
    );
    expect(createFacebookDraft).toHaveBeenCalledOnce();
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it("timeout on both attempts → throws, no draft created, error logged", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockCreate
      // Attempt 1: fr rejects, en resolves (ignored)
      .mockRejectedValueOnce(makeTimeout())
      .mockResolvedValueOnce(makeMsg("(ignored)"))
      // Attempt 2 (retry): fr rejects, en resolves (ignored)
      .mockRejectedValueOnce(makeTimeout())
      .mockResolvedValueOnce(makeMsg("(ignored)"));

    await expect(triggerStockHighlight()).rejects.toThrow();
    expect(createFacebookDraft).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(4);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("anthropic failed after retry"),
    );
  });

  // ── Scenario 4: non-timeout API error → throw immediately, no retry ─

  it("non-timeout API error → throws immediately, no retry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Error with default name "Error" — not TimeoutError, not AbortError.
    const apiError = new Error("429 Too Many Requests");

    mockCreate
      .mockRejectedValueOnce(apiError)              // fr: 429 error
      .mockResolvedValueOnce(makeMsg("(ignored)")); // en: resolves (ignored)

    await expect(triggerStockHighlight()).rejects.toThrow("429 Too Many Requests");
    expect(createFacebookDraft).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Retry path must NOT have been reached.
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("anthropic timeout, retrying"),
    );
  });
});

// ─── triggerNewProduct — Creatomate decoupled (static posts only) ─────
//
// Job 4 no longer generates video. These tests lock in that the new-product
// draft is created WITHOUT videoUrl/reelsVideoUrl — the FFmpeg slideshow
// pipeline owns video rendering now.

describe("triggerNewProduct — static posts only (Creatomate decoupled)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue({
      ...SETTINGS,
      prompt_new_product_fr: "Post FR pour {product_name}",
      prompt_new_product_en: "Post EN for {product_name}",
    });
    // PRODUCT is a minimal fixture; getProduct's ProductRow is wider than we
    // need here, so cast to the awaited return type for the mock.
    vi.mocked(getProduct).mockResolvedValue(
      PRODUCT as unknown as Awaited<ReturnType<typeof getProduct>>,
    );
    vi.mocked(createFacebookDraft).mockResolvedValue(DRAFT_ID);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    vi.mocked(resolveLifestyle).mockResolvedValue({ ...LIFESTYLE_VERIFIED });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a draft with no video fields and no render call", async () => {
    mockCreate
      .mockResolvedValueOnce(makeMsg("Texte FR généré"))
      .mockResolvedValueOnce(makeMsg("Generated EN text"));

    const result = await triggerNewProduct("TEST-001");

    expect(result).not.toBeNull();
    expect(result!.draftId).toBe(DRAFT_ID);
    expect(createFacebookDraft).toHaveBeenCalledOnce();

    // The draft payload must carry neither a square nor a reels video URL —
    // Job 4 is decoupled from Creatomate and produces static branded posts.
    const draftArg = vi.mocked(createFacebookDraft).mock.calls[0][0];
    expect(draftArg.videoUrl).toBeUndefined();
    expect(draftArg.reelsVideoUrl).toBeUndefined();
    expect("videoUrl" in draftArg).toBe(false);
    expect("reelsVideoUrl" in draftArg).toBe(false);
  });
});
