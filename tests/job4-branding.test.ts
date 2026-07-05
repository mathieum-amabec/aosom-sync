import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { triggerNewProduct, triggerStockHighlight, triggerPriceDrop } from "@/jobs/job4-social";

// ─── Mocks ────────────────────────────────────────────────────────────
//
// getPublicAppUrl returns a real public base here, so brandImages() is active
// and the branded /api/image-preview URL is the ONLY posted image (the raw Aosom
// gallery is deliberately dropped — it still contains white-bg / spec shots).
// resolveLifestyle is stubbed verified so the lifestyle gate lets the post through.

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getEligibleHighlightCandidates: vi.fn(),
  getProduct: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  createNotification: vi.fn(),
  getAutopostCountToday: vi.fn(),
  incrementAutopostCountToday: vi.fn(),
}));

// Lifestyle gate: verified so the trigger proceeds (unverified → skip → null).
vi.mock("@/lib/selectors/shopify-images", () => ({
  resolveLifestyle: vi.fn(),
}));

// composeImage must NOT be called when branding is active.
const composeImage = vi.hoisted(() => vi.fn().mockResolvedValue("/legacy/path.jpg"));
vi.mock("@/lib/image-composer", () => ({ composeImage }));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore" },
  CLAUDE: { MODEL: "claude-test", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {},
  getPublicAppUrl: () => "https://app.example.com",
}));

vi.mock("@/lib/social-publisher", () => ({ publishDraftToChannels: vi.fn() }));

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
  prompt_new_product_fr: "Post FR {product_name}",
  prompt_new_product_en: "Post EN {product_name}",
  prompt_highlight_fr: "Post FR {product_name}",
  prompt_highlight_en: "Post EN {product_name}",
  prompt_price_drop_fr: "Baisse {product_name}",
  prompt_price_drop_en: "Drop {product_name}",
};

const PRODUCT = {
  sku: "TEST-001",
  name: "Test Product",
  price: 249.99,
  qty: 5,
  shopify_product_id: "111",
  image1: "https://cdn.example.com/a.jpg",
  image2: "https://cdn.example.com/b.jpg",
};

function makeMsg(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

describe("job4 branding integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);
    vi.mocked(getEligibleHighlightCandidates).mockResolvedValue([PRODUCT] as never);
    vi.mocked(getProduct).mockResolvedValue(PRODUCT as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(7);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    vi.mocked(resolveLifestyle).mockResolvedValue({
      verified: true,
      primaryImageUrl: "https://cdn.shopify.com/s/files/lifestyle.jpg",
    });
    mockCreate.mockResolvedValue(makeMsg("text"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("new_product: posts ONLY the branded badge=new hero (no white-bg gallery)", async () => {
    const result = await triggerNewProduct("TEST-001");
    expect(result).not.toBeNull();

    const branded = "https://app.example.com/api/image-preview?sku=TEST-001&locale=fr&price=249.99&badge=new";
    expect(result!.imageUrls[0]).toBe(branded);
    expect(result!.imageUrl).toBe(branded);
    expect(result!.imagePath).toBe(branded);

    // The raw Aosom gallery must NOT be appended — only the branded lifestyle hero.
    expect(result!.imageUrls).toEqual([branded]);

    // The branded URL was persisted to the draft as the sole image.
    const draftArg = vi.mocked(createFacebookDraft).mock.calls[0][0];
    expect(draftArg.imageUrls).toEqual([branded]);
    expect(draftArg.imagePath).toBe(branded);

    // Legacy overlay must be bypassed when branding is active.
    expect(composeImage).not.toHaveBeenCalled();
  });

  it("new_product: skips (returns null) when the product is not lifestyle-verified", async () => {
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null });
    const result = await triggerNewProduct("TEST-001");
    expect(result).toBeNull();
    expect(createFacebookDraft).not.toHaveBeenCalled();
  });

  it("new_product: skips when tagged but no clean photo resolves (verified, url=null)", async () => {
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: true, primaryImageUrl: null });
    const result = await triggerNewProduct("TEST-001");
    expect(result).toBeNull();
    expect(createFacebookDraft).not.toHaveBeenCalled();
  });

  it("price_drop: posts a single branded badge=sale hero when verified", async () => {
    const result = await triggerPriceDrop("TEST-001", 100, 80);
    const branded = "https://app.example.com/api/image-preview?sku=TEST-001&locale=fr&price=80.00&badge=sale";
    expect(result).not.toBeNull();
    expect(result!.imageUrls).toEqual([branded]);
    expect(composeImage).not.toHaveBeenCalled();
  });

  it("price_drop: skips (returns null) when not lifestyle-verified", async () => {
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null });
    const result = await triggerPriceDrop("TEST-001", 100, 80);
    expect(result).toBeNull();
    expect(createFacebookDraft).not.toHaveBeenCalled();
  });

  it("stock_highlight: branded URL has no badge param and is the only image", async () => {
    const result = await triggerStockHighlight();
    const branded = "https://app.example.com/api/image-preview?sku=TEST-001&locale=fr&price=249.99";
    expect(result?.imageUrls).toEqual([branded]);
    expect(result?.imagePath).toBe(branded);
    expect(composeImage).not.toHaveBeenCalled();
  });

  it("stock_highlight: skips when no eligible candidate is lifestyle-verified", async () => {
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null });
    const result = await triggerStockHighlight();
    expect(result).toBeNull();
    expect(createFacebookDraft).not.toHaveBeenCalled();
  });
});
