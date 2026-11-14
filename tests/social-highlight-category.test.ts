import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runStockHighlight, triggerStockHighlight, effectiveCooldownDays } from "@/jobs/job4-social";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getEligibleHighlightCandidatesTrendAware: vi.fn(),
  nextHighlightAvailableAt: vi.fn(),
  getPendingSocialCandidates: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  getProduct: vi.fn(),
  createNotification: vi.fn(),
  getAutopostCountToday: vi.fn(),
  incrementAutopostCountToday: vi.fn(),
}));

vi.mock("@/lib/selectors/shopify-images", () => ({ resolveLifestyle: vi.fn() }));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore" },
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {},
}));

vi.mock("@/lib/social-publisher", () => ({ publishDraftToChannels: vi.fn() }));

import {
  getAllSettings,
  getEligibleHighlightCandidatesTrendAware,
  nextHighlightAvailableAt,
  createFacebookDraft,
  markProductPosted,
  createNotification,
} from "@/lib/database";
import { resolveLifestyle } from "@/lib/selectors/shopify-images";
import { getCategory } from "@/lib/social-categories";

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
  product_type: "Patio & Garden > Patio Furniture",
};

/** The `filter` argument getEligibleHighlightCandidatesTrendAware received on call #n. */
function filterArg(n: number) {
  return vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls[n]?.[2];
}

describe("stock highlight category filtering", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS as never);
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([PRODUCT] as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(1);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    vi.mocked(createNotification).mockResolvedValue(undefined as never);
    vi.mocked(resolveLifestyle).mockResolvedValue({
      verified: true,
      primaryImageUrl: "https://cdn.shopify.com/s/files/lifestyle.jpg",
    } as never);
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "caption" }] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("passes the chosen category's predicate down to the SQL layer", async () => {
    const run = await runStockHighlight(1, "animaux");
    expect(run.drafts).toHaveLength(1);
    expect(run.categoryUsed).toBe("animaux");
    expect(run.categorySource).toBe("explicit");
    expect(run.fellBackToAll).toBe(false);
    expect(filterArg(0)).toEqual({
      predicate: getCategory("animaux")!.predicate,
      args: [],
    });
  });

  it("'all' sends no filter at all", async () => {
    const run = await runStockHighlight(1, "all");
    expect(filterArg(0)).toBeNull();
    expect(run.categoryUsed).toBeNull();
    expect(run.categorySource).toBe("none");
  });

  it("applies the month's seasonal preference when nothing is chosen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00"));
    const run = await runStockHighlight(1);
    expect(filterArg(0)).toEqual({
      predicate: getCategory("halloween")!.predicate,
      args: [],
    });
    expect(run.categorySource).toBe("seasonal");
    expect(run.categoryUsed).toBe("halloween");
  });

  it("widens to the whole catalog when the season yields nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00"));
    vi.mocked(getEligibleHighlightCandidatesTrendAware)
      .mockResolvedValueOnce([] as never) // no Halloween product in stock
      .mockResolvedValue([PRODUCT] as never);

    const run = await runStockHighlight(1);
    expect(run.drafts).toHaveLength(1);
    expect(run.fellBackToAll).toBe(true);
    expect(run.categoryUsed).toBeNull();
    // First attempt filtered, second unfiltered.
    expect(filterArg(0)).not.toBeNull();
    expect(filterArg(1)).toBeNull();
  });

  it("an EXPLICIT category never widens — an empty Halloween stays empty", async () => {
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([] as never);
    const run = await runStockHighlight(1, "halloween");
    expect(run.drafts).toHaveLength(0);
    expect(run.fellBackToAll).toBe(false);
    // Exactly one attempt: no silent retry against the whole catalog.
    expect(vi.mocked(getEligibleHighlightCandidatesTrendAware)).toHaveBeenCalledTimes(1);
  });

  it("names the category in the empty-run notification", async () => {
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([] as never);
    await runStockHighlight(1, "noel");
    const [, , body] = vi.mocked(createNotification).mock.calls[0];
    expect(body).toContain("🎄 Noël");
  });

  it("out of season with no choice, it queries the whole catalog once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00"));
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([] as never);
    const run = await runStockHighlight(1);
    expect(filterArg(0)).toBeNull();
    expect(run.fellBackToAll).toBe(false);
    expect(vi.mocked(getEligibleHighlightCandidatesTrendAware)).toHaveBeenCalledTimes(1);
  });

  it("triggerStockHighlight still returns a plain draft array", async () => {
    const drafts = await triggerStockHighlight(1, "all");
    expect(Array.isArray(drafts)).toBe(true);
    expect(drafts).toHaveLength(1);
  });
});

describe("stock highlight cooldown — seasonal pools and why a run came up empty", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS as never);
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([PRODUCT] as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(1);
    vi.mocked(createNotification).mockResolvedValue(undefined as never);
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: true, primaryImageUrl: "https://cdn/x.jpg" } as never);
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "caption" }] });
  });

  it("seasonal categories use a 7-day cooldown; everything else keeps the 30-day setting", () => {
    expect(effectiveCooldownDays(30, getCategory("halloween")!)).toBe(7);
    expect(effectiveCooldownDays(30, getCategory("noel")!)).toBe(7);
    expect(effectiveCooldownDays(30, getCategory("salon")!)).toBe(30);
    expect(effectiveCooldownDays(30, null)).toBe(30);
    expect(effectiveCooldownDays(5, getCategory("halloween")!)).toBe(5); // never LONGER than the setting
  });

  it("Halloween is sampled with the 7-day cooldown", async () => {
    await runStockHighlight(1, "halloween");
    expect(vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls[0][0]).toBe(7);
  });

  it("the seasonal-to-catalog fallback goes back to the normal 30 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00"));
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValueOnce([] as never).mockResolvedValue([PRODUCT] as never);
    await runStockHighlight(1);
    const calls = vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls;
    expect(calls[0][0]).toBe(7);
    expect(calls[1][0]).toBe(30);
    vi.useRealTimers();
  });

  it("an empty pool reports 'cooldown' with the date the first product frees up", async () => {
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([] as never);
    vi.mocked(nextHighlightAvailableAt).mockResolvedValue(1_790_900_000);
    const run = await runStockHighlight(1, "halloween");
    expect(run).toMatchObject({ drafts: [], emptyReason: "cooldown", nextAvailableAt: 1_790_900_000, cooldownDays: 7 });
    expect(vi.mocked(nextHighlightAvailableAt)).toHaveBeenCalledWith(7, { predicate: getCategory("halloween")!.predicate, args: [] });
    expect(vi.mocked(createNotification).mock.calls[0][2]).toBe("Tous les produits « 🎃 Halloween » ont déjà un post de moins de 7 jours");
  });

  it("candidates without a verified photo report 'no_lifestyle' (no date lookup)", async () => {
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null } as never);
    const run = await runStockHighlight(1, "halloween");
    expect(run).toMatchObject({ drafts: [], emptyReason: "no_lifestyle", nextAvailableAt: null });
    expect(vi.mocked(nextHighlightAvailableAt)).not.toHaveBeenCalled();
  });

  it("a successful run has no empty reason", async () => {
    const run = await runStockHighlight(1, "halloween");
    expect(run).toMatchObject({ emptyReason: null, nextAvailableAt: null });
    expect(run.drafts).toHaveLength(1);
  });
});
