import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

/**
 * Social fine targeting (2026-10-02):
 *  - the highlight draw is restricted to lifestyle-verified products up front (the
 *    "Bureau & Télétravail ne peut pas générer" bug: 17 verified fiches lost in a blind
 *    15-SKU sample);
 *  - product_type-branch targets and saved themes, strict when picked by hand, soft (with
 *    catalog fallback) when the daily cron prefers one.
 */

const mockCreate = vi.hoisted(() => vi.fn());
const mockVerified = vi.hoisted(() => vi.fn());

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
vi.mock("@/lib/selectors/lifestyle-verified-set", () => ({ getLifestyleVerifiedProductIds: mockVerified }));

vi.mock("@/lib/config", () => ({
  env: { storeName: "TestStore" },
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch", MAX_TOKENS_SOCIAL: 500 },
  SYNC: { DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30" },
  CHANNELS: {},
}));

vi.mock("@/lib/social-publisher", () => ({ publishDraftToChannels: vi.fn() }));

import { runStockHighlight, generateSocialBatch } from "@/jobs/job4-social";
import {
  getAllSettings,
  getEligibleHighlightCandidatesTrendAware,
  getPendingSocialCandidates,
  createFacebookDraft,
  markProductPosted,
  createNotification,
} from "@/lib/database";
import { resolveLifestyle } from "@/lib/selectors/shopify-images";
import {
  buildTargetCategory,
  parseThemes,
  validateProductTypes,
  SOCIAL_THEMES_KEY,
  SOCIAL_AUTO_THEME_KEY,
} from "@/lib/social-categories";
import { buildTargetTree } from "@/lib/social-targets";

const SETTINGS = {
  social_min_days_between_reposts: "30",
  prompt_highlight_fr: "Post FR pour {product_name}",
  prompt_highlight_en: "Post EN for {product_name}",
  social_hashtags_fr: "#test",
  social_hashtags_en: "#test",
};

const PRODUCT = {
  sku: "OF-1",
  name: "Desk",
  price: 99.99,
  qty: 5,
  shopify_product_id: "111",
  product_type: "Office Products > Office Furniture > Desks",
};

const FIRE_PITS = "Patio & Garden > Fire Pits";
const SHELTERS = "Patio & Garden > Wedding & Events Tents > Car Shelters";

describe("stock highlight — verified-first draw", () => {
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
  afterEach(() => vi.restoreAllMocks());

  it("hands the verified set to the sampler so the draw happens among postable products", async () => {
    const verified = new Set(["111"]);
    mockVerified.mockResolvedValue(verified);
    const run = await runStockHighlight(1, "bureau");
    expect(run.drafts).toHaveLength(1);
    expect(vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls[0][3]).toBe(verified);
  });

  it("an empty verified draw with free unverified products is a photo miss, not a cooldown", async () => {
    mockVerified.mockResolvedValue(new Set(["999"]));
    vi.mocked(getEligibleHighlightCandidatesTrendAware)
      .mockResolvedValueOnce([] as never) // nothing verified + free
      .mockResolvedValueOnce([PRODUCT] as never); // but free products exist
    const run = await runStockHighlight(1, "bureau");
    expect(run.drafts).toHaveLength(0);
    expect(run.emptyReason).toBe("no_lifestyle");
  });

  it("an empty pool even without the photo restriction is the cooldown", async () => {
    mockVerified.mockResolvedValue(new Set(["111"]));
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([] as never);
    const run = await runStockHighlight(1, "bureau");
    expect(run.emptyReason).toBe("cooldown");
  });

  it("falls back to the blind draw when Shopify can't list verified products", async () => {
    mockVerified.mockResolvedValue(null);
    const run = await runStockHighlight(1, "bureau");
    expect(run.drafts).toHaveLength(1);
    expect(vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls[0][3]).toBeNull();
  });

  it("a hand-picked target is strict: no widening to the catalog", async () => {
    mockVerified.mockResolvedValue(new Set(["111"]));
    vi.mocked(getEligibleHighlightCandidatesTrendAware).mockResolvedValue([] as never);
    const target = buildTargetCategory("Automne", [FIRE_PITS]);
    const run = await runStockHighlight(3, { target });
    expect(run.drafts).toHaveLength(0);
    expect(run.fellBackToAll).toBe(false);
    expect(run.categorySource).toBe("explicit");
    expect(vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls[0][2]).toEqual({
      predicate: target.predicate,
      args: target.args,
    });
  });

  it("the daily cron prefers the saved auto theme, softly", async () => {
    mockVerified.mockResolvedValue(new Set(["111"]));
    vi.mocked(getPendingSocialCandidates).mockResolvedValue([]);
    vi.mocked(getAllSettings).mockResolvedValue({
      ...SETTINGS,
      [SOCIAL_THEMES_KEY]: JSON.stringify([{ id: "t1", label: "Automne", productTypes: [FIRE_PITS, SHELTERS] }]),
      [SOCIAL_AUTO_THEME_KEY]: "t1",
    } as never);
    vi.mocked(getEligibleHighlightCandidatesTrendAware)
      .mockResolvedValueOnce([] as never) // theme exhausted
      .mockResolvedValueOnce([] as never) // (cooldown probe)
      .mockResolvedValue([PRODUCT] as never); // whole catalog
    const drafts = await generateSocialBatch(1);
    expect(drafts).toHaveLength(1);
    const firstFilter = vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls[0][2];
    expect(firstFilter?.args).toEqual(buildTargetCategory("Automne", [FIRE_PITS, SHELTERS]).args);
    // Widened: the last draw had no filter.
    const calls = vi.mocked(getEligibleHighlightCandidatesTrendAware).mock.calls;
    expect(calls[calls.length - 1][2]).toBeNull();
  });
});

describe("product_type targets as executable SQL", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(`CREATE TABLE products (sku TEXT PRIMARY KEY, product_type TEXT)`);
    for (const [sku, type] of [
      ["FP-1", FIRE_PITS],
      ["FP-2", `${FIRE_PITS} > Gas`],
      ["FPX", "Patio & Garden > Fire Pitsx"], // shares the prefix but is NOT a sub-branch
      ["CS-1", SHELTERS],
      ["U-1", "Patio & Garden > A_B"],
      ["U-2", "Patio & Garden > AxB"], // "_" must not act as a wildcard
    ]) {
      await db.execute({ sql: `INSERT INTO products VALUES (?, ?)`, args: [sku, type] });
    }
  });
  afterEach(() => db.close());

  async function select(types: string[]): Promise<string[]> {
    const c = buildTargetCategory("x", types);
    const { rows } = await db.execute({ sql: `SELECT sku FROM products WHERE (${c.predicate})`, args: c.args });
    return rows.map((r) => String((r as unknown as Record<string, unknown>).sku)).sort();
  }

  it("a branch selects itself and its sub-branches, not look-alike siblings", async () => {
    expect(await select([FIRE_PITS])).toEqual(["FP-1", "FP-2"]);
  });

  it("several branches are OR-ed", async () => {
    expect(await select([FIRE_PITS, SHELTERS])).toEqual(["CS-1", "FP-1", "FP-2"]);
  });

  it("LIKE wildcards in a product_type are literal", async () => {
    expect(await select(["Patio & Garden > A_B"])).toEqual(["U-1"]);
  });
});

describe("theme validation", () => {
  it("validateProductTypes trims, dedupes and rejects empty/oversized input", () => {
    expect(validateProductTypes([" a ", "a", "b"])).toEqual(["a", "b"]);
    expect(validateProductTypes([])).toBeNull();
    expect(validateProductTypes(["ok", ""])).toBeNull();
    expect(validateProductTypes("a")).toBeNull();
    expect(validateProductTypes(Array.from({ length: 61 }, (_, i) => `t${i}`))).toBeNull();
  });

  it("parseThemes drops malformed entries instead of failing", () => {
    const raw = JSON.stringify([
      { id: "t1", label: "Automne", productTypes: [FIRE_PITS] },
      { id: "", label: "x", productTypes: ["a"] },
      { id: "t3", label: "Vide", productTypes: [] },
    ]);
    expect(parseThemes(raw)).toEqual([{ id: "t1", label: "Automne", productTypes: [FIRE_PITS] }]);
    expect(parseThemes("not json")).toEqual([]);
    expect(parseThemes(null)).toEqual([]);
  });
});

describe("buildTargetTree", () => {
  const now = 1_800_000_000;
  const cutoff = now - 30 * 86400;
  const rows = [
    { productType: FIRE_PITS, shopifyProductId: "A", lastPostedAt: null },
    { productType: FIRE_PITS, shopifyProductId: "A", lastPostedAt: null }, // 2nd colour, same fiche
    { productType: `${FIRE_PITS} > Gas`, shopifyProductId: "B", lastPostedAt: now - 86400 }, // recent post
    { productType: SHELTERS, shopifyProductId: "C", lastPostedAt: null }, // not verified
  ];

  it("counts distinct fiches per subtree, verified and postable", () => {
    const tree = buildTargetTree(rows, new Set(["A", "B"]), cutoff);
    const at = (p: string) => tree.find((n) => n.path === p)!;
    expect(at("Patio & Garden")).toMatchObject({ depth: 0, fiches: 3, verified: 2, postable: 1 });
    expect(at(FIRE_PITS)).toMatchObject({ name: "Fire Pits", depth: 1, fiches: 2, verified: 2, postable: 1 });
    expect(at(`${FIRE_PITS} > Gas`)).toMatchObject({ fiches: 1, verified: 1, postable: 0 });
    expect(at(SHELTERS)).toMatchObject({ fiches: 1, verified: 0, postable: 0 });
  });

  it("reports unknown photo counts as null when Shopify could not say", () => {
    const tree = buildTargetTree(rows, null, cutoff);
    expect(tree.every((n) => n.verified === null && n.postable === null)).toBe(true);
  });
});
