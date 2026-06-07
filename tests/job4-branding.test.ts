import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { triggerNewProduct, triggerStockHighlight } from "@/jobs/job4-social";

// ─── Mocks ────────────────────────────────────────────────────────────
//
// getPublicAppUrl returns a real public base here, so brandImages() is active
// and the branded /api/image-preview URL should be injected as imageUrls[0].

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getEligibleHighlightProduct: vi.fn(),
  getProduct: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  createNotification: vi.fn(),
  getAutopostCountToday: vi.fn(),
  incrementAutopostCountToday: vi.fn(),
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
  getEligibleHighlightProduct,
  getProduct,
  createFacebookDraft,
  markProductPosted,
} from "@/lib/database";

const SETTINGS = {
  social_min_days_between_reposts: "30",
  prompt_new_product_fr: "Post FR {product_name}",
  prompt_new_product_en: "Post EN {product_name}",
  prompt_highlight_fr: "Post FR {product_name}",
  prompt_highlight_en: "Post EN {product_name}",
};

const PRODUCT = {
  sku: "TEST-001",
  name: "Test Product",
  price: 249.99,
  qty: 5,
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
    vi.mocked(getEligibleHighlightProduct).mockResolvedValue(PRODUCT as never);
    vi.mocked(getProduct).mockResolvedValue(PRODUCT as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(7);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    mockCreate.mockResolvedValue(makeMsg("text"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("new_product: prepends branded URL with badge=new and stores it in image_path", async () => {
    const result = await triggerNewProduct("TEST-001");

    const branded = "https://app.example.com/api/image-preview?sku=TEST-001&locale=fr&price=249.99&badge=new";
    expect(result.imageUrls[0]).toBe(branded);
    expect(result.imageUrl).toBe(branded);
    expect(result.imagePath).toBe(branded);

    // Raw Aosom photos are preserved after the branded hero.
    expect(result.imageUrls.length).toBeGreaterThanOrEqual(2);
    expect(result.imageUrls.slice(1).every((u) => u.startsWith("https://cdn.example.com/"))).toBe(true);

    // The branded URL was persisted to the draft.
    const draftArg = vi.mocked(createFacebookDraft).mock.calls[0][0];
    expect(draftArg.imageUrls?.[0]).toBe(branded);
    expect(draftArg.imagePath).toBe(branded);

    // Legacy overlay must be bypassed when branding is active.
    expect(composeImage).not.toHaveBeenCalled();
  });

  it("stock_highlight: branded URL has no badge param", async () => {
    const result = await triggerStockHighlight();
    const branded = "https://app.example.com/api/image-preview?sku=TEST-001&locale=fr&price=249.99";
    expect(result?.imageUrls[0]).toBe(branded);
    expect(result?.imagePath).toBe(branded);
    expect(composeImage).not.toHaveBeenCalled();
  });
});
