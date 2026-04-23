import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { pickRandomImages, triggerStockHighlight } from "@/jobs/job4-social";

// ─── Mock factories ───────────────────────────────────────────────────

// vi.hoisted ensures mockCreate is defined before vi.mock() factories run.
const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getEligibleHighlightProduct: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  getProduct: vi.fn(),
  createNotification: vi.fn(),
  getAutopostCountToday: vi.fn(),
  incrementAutopostCountToday: vi.fn(),
}));

vi.mock("@/lib/image-composer", () => ({
  composeImage: vi.fn().mockResolvedValue(null),
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
  getEligibleHighlightProduct,
  createFacebookDraft,
  markProductPosted,
} from "@/lib/database";

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
  image1: "https://cdn.example.com/img.jpg",
};

const DRAFT_ID = 42;

function makeMsg(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function makeTimeout() {
  // Use the real SDK error class so tests match what AbortSignal.timeout() causes
  // in production (SDK wraps it into APIUserAbortError, not a raw "TimeoutError").
  return new Anthropic.APIUserAbortError();
}

// ─── pickRandomImages ─────────────────────────────────────────────────

describe("pickRandomImages", () => {
  it("returns empty array when product has no images", () => {
    expect(pickRandomImages({})).toEqual([]);
    expect(pickRandomImages({ image1: "", image2: "  " })).toEqual([]);
  });

  it("caps selection at the number of available images", () => {
    const product = { image1: "a", image2: "b" };
    for (let i = 0; i < 50; i++) {
      const picked = pickRandomImages(product);
      expect(picked.length).toBeGreaterThanOrEqual(1);
      expect(picked.length).toBeLessThanOrEqual(2);
      for (const u of picked) expect(["a", "b"]).toContain(u);
    }
  });

  it("never picks more than 5 even when 7 are available", () => {
    const product = {
      image1: "a", image2: "b", image3: "c", image4: "d",
      image5: "e", image6: "f", image7: "g",
    };
    for (let i = 0; i < 100; i++) {
      const picked = pickRandomImages(product);
      expect(picked.length).toBeGreaterThanOrEqual(1);
      expect(picked.length).toBeLessThanOrEqual(5);
      expect(new Set(picked).size).toBe(picked.length);
    }
  });

  it("varies the count across many runs (not always the same N)", () => {
    const product = {
      image1: "a", image2: "b", image3: "c", image4: "d", image5: "e",
    };
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) counts.add(pickRandomImages(product).length);
    expect(counts.size).toBeGreaterThanOrEqual(2);
  });

  it("varies the order across runs (shuffle is applied)", () => {
    const product = {
      image1: "a", image2: "b", image3: "c", image4: "d", image5: "e",
    };
    const firsts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = pickRandomImages(product);
      if (picked.length > 0) firsts.add(picked[0]);
    }
    expect(firsts.size).toBeGreaterThanOrEqual(2);
  });
});

// ─── triggerStockHighlight — Anthropic timeout handling ───────────────

describe("triggerStockHighlight — Anthropic timeout handling", () => {
  beforeEach(() => {
    // Clear call history before every test so counts don't bleed across.
    vi.resetAllMocks();

    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);
    vi.mocked(getEligibleHighlightProduct).mockResolvedValue(PRODUCT);
    vi.mocked(createFacebookDraft).mockResolvedValue(DRAFT_ID);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
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
