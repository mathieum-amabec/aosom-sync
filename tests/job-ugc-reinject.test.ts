import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/content-generator", () => ({
  getAnthropicClient: () => ({ messages: { create: mockCreate } }),
}));

vi.mock("@/lib/database", () => ({
  getAllSettings: vi.fn(),
  getUgcVideoCandidates: vi.fn(),
  getProduct: vi.fn(),
  createFacebookDraft: vi.fn(),
  markProductPosted: vi.fn(),
  isDraftVideoUrlUsed: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore" },
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {},
}));

import {
  getAllSettings,
  getUgcVideoCandidates,
  getProduct,
  createFacebookDraft,
  markProductPosted,
  isDraftVideoUrlUsed,
} from "@/lib/database";
import { generateUgcReinjectionBatch, DEFAULT_UGC_REINJECT_BATCH } from "@/jobs/job-ugc-reinject";

function makeMsg(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const SETTINGS = {
  prompt_highlight_fr: "Post FR pour {product_name}",
  prompt_highlight_en: "Post EN for {product_name}",
};

const CANDIDATE = (sku: string) => ({
  sku,
  name: `Produit ${sku}`,
  price: 49.99,
  qty: 12,
  shopifyProductId: "111",
  shopifyHandle: "handle",
  videoUgc: `https://cdn.example.com/customer/CA/${sku}.mp4`,
});

describe("generateUgcReinjectionBatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllSettings).mockResolvedValue(SETTINGS);
    vi.mocked(getProduct).mockResolvedValue({ product_type: "Home Furnishings" } as never);
    vi.mocked(createFacebookDraft).mockResolvedValue(1);
    vi.mocked(markProductPosted).mockResolvedValue(undefined);
    vi.mocked(isDraftVideoUrlUsed).mockResolvedValue(false);
    mockCreate.mockResolvedValue(makeMsg("texte"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("creates one draft per eligible, never-reinjected UGC candidate, up to `count`", async () => {
    vi.mocked(getUgcVideoCandidates).mockResolvedValue([
      CANDIDATE("SKU-1"),
      CANDIDATE("SKU-2"),
      CANDIDATE("SKU-3"),
    ] as never);
    vi.mocked(createFacebookDraft).mockResolvedValueOnce(101).mockResolvedValueOnce(102);

    const results = await generateUgcReinjectionBatch(2);

    expect(results).toHaveLength(2);
    expect(createFacebookDraft).toHaveBeenCalledTimes(2);
    expect(markProductPosted).toHaveBeenCalledTimes(2);
  });

  it("skips a candidate whose video was already reinjected", async () => {
    vi.mocked(getUgcVideoCandidates).mockResolvedValue([CANDIDATE("SKU-1"), CANDIDATE("SKU-2")] as never);
    vi.mocked(isDraftVideoUrlUsed).mockImplementation(async (url: string) => url.includes("SKU-1"));

    const results = await generateUgcReinjectionBatch(5);

    expect(results).toHaveLength(1);
    expect(results[0].sku).toBe("SKU-2");
  });

  it("passes videoUrl AND reelsVideoUrl through to createFacebookDraft", async () => {
    vi.mocked(getUgcVideoCandidates).mockResolvedValue([CANDIDATE("SKU-1")] as never);

    await generateUgcReinjectionBatch(1);

    const arg = vi.mocked(createFacebookDraft).mock.calls[0][0];
    expect(arg.videoUrl).toBe("https://cdn.example.com/customer/CA/SKU-1.mp4");
    expect(arg.reelsVideoUrl).toBe("https://cdn.example.com/customer/CA/SKU-1.mp4");
    // createFacebookDraft defaults status to 'draft' at the DB layer (column DEFAULT
    // 'draft') — this call never passes a status, confirming it can't force-approve.
    expect("status" in arg).toBe(false);
  });

  it("empty candidate pool → empty result, no draft created", async () => {
    vi.mocked(getUgcVideoCandidates).mockResolvedValue([]);

    const results = await generateUgcReinjectionBatch();

    expect(results).toEqual([]);
    expect(createFacebookDraft).not.toHaveBeenCalled();
  });

  it("default batch size is a small, deliberate number (never dumps the whole backlog)", () => {
    expect(DEFAULT_UGC_REINJECT_BATCH).toBeGreaterThan(0);
    expect(DEFAULT_UGC_REINJECT_BATCH).toBeLessThanOrEqual(10);
  });
});
