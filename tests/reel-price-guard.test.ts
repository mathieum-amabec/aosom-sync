import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ ensureSchema: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/database", () => db);
const shop = vi.hoisted(() => ({ shopifyFetch: vi.fn() }));
vi.mock("@/lib/shopify-client", () => shop);

import { runReelPriceGuard, parseBadges, badgeProblem, livePct, fetchVariantBySku, type GuardDeps, type LiveVariant, type GuardRow } from "@/lib/reel-price-guard";

const variant = (o: Partial<LiveVariant> = {}): LiveVariant => ({ sku: "830-001", price: 70, compareAt: 100, availableForSale: true, productStatus: "ACTIVE", ...o });
const row = (id: number, badges: unknown, o: Partial<GuardRow> = {}): GuardRow => ({
  id, contentId: `reel:${id}`, scheduledAt: "2026-11-02 14:00:00", metadata: badges === undefined ? null : JSON.stringify({ source: "x", badges }), ...o,
});

describe("badge parsing and comparison", () => {
  it("reads badges and ignores malformed metadata", () => {
    expect(parseBadges(JSON.stringify({ badges: [{ sku: "830-001", pct: 30 }, { sku: "", pct: 5 }, { pct: 9 }, null] }))).toEqual([{ sku: "830-001", pct: 30 }]);
    expect(parseBadges("not json")).toEqual([]);
    expect(parseBadges(JSON.stringify({ style: "x" }))).toEqual([]);
    expect(parseBadges(null)).toEqual([]);
  });

  it("computes the live rabais like the store shows it", () => {
    expect(livePct(variant())).toBe(30);
    expect(livePct(variant({ price: 79.99, compareAt: 99.99 }))).toBe(20);
    expect(livePct(variant({ compareAt: null }))).toBe(0);
    expect(livePct(variant({ compareAt: 60 }))).toBe(0); // compare-at below price is no rabais
  });

  it("accepts a matching badge and explains every mismatch", () => {
    expect(badgeProblem({ sku: "830-001", pct: 30 }, variant())).toBeNull();
    expect(badgeProblem({ sku: "830-001", pct: 30 }, variant({ price: 88 }))).toContain("Shopify donne -12 %");
    expect(badgeProblem({ sku: "830-001", pct: 30 }, variant({ compareAt: null }))).toContain("aucun prix barré");
    expect(badgeProblem({ sku: "830-001", pct: 30 }, null)).toContain("introuvable");
    expect(badgeProblem({ sku: "830-001", pct: 30 }, variant({ productStatus: "DRAFT" }))).toContain("draft");
    expect(badgeProblem({ sku: "830-001", pct: 30 }, variant({ availableForSale: false }))).toContain("plus en vente");
  });
});

describe("runReelPriceGuard", () => {
  let deps: GuardDeps;
  let live: Record<string, LiveVariant | null | Error>;

  beforeEach(() => {
    live = { "830-001": variant(), "830-002": variant({ sku: "830-002", price: 90, compareAt: 100 }) };
    deps = {
      loadRows: vi.fn(async () => []),
      fetchVariant: vi.fn(async (sku: string) => {
        const v = live[sku];
        if (v instanceof Error) throw v;
        return v ?? null;
      }),
      blockRow: vi.fn(async () => true),
      saveResult: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
    };
  });

  it("leaves a Reel whose badges still match, and ignores Reels without badges", async () => {
    deps.loadRows = vi.fn(async () => [row(1, [{ sku: "830-001", pct: 30 }]), row(2, undefined)]);
    const r = await runReelPriceGuard({ now: new Date("2026-11-01T12:00:00Z") }, deps);
    expect(r).toMatchObject({ rows: 2, checked: 1, ok: 1, blocked: [], unverified: [] });
    expect(deps.blockRow).not.toHaveBeenCalled();
    expect(deps.saveResult).toHaveBeenCalledWith(expect.objectContaining({ checkedAt: "2026-11-01T12:00:00.000Z", ok: 1 }));
  });

  it("moves a Reel with a stale rabais to draft with a price-guard error", async () => {
    deps.loadRows = vi.fn(async () => [row(7, [{ sku: "830-001", pct: 30 }, { sku: "830-002", pct: 25 }])]);
    const r = await runReelPriceGuard({}, deps);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0].reason).toContain("830-002");
    expect(r.blocked[0].reason).not.toContain("830-001");
    expect(deps.blockRow).toHaveBeenCalledWith(7, expect.stringMatching(/^price-guard: 830-002: la vidéo affiche -25 %, Shopify donne -10 %/));
  });

  it("blocks a Reel whose product is gone or no longer active", async () => {
    live["830-009"] = null;
    deps.loadRows = vi.fn(async () => [row(8, [{ sku: "830-009", pct: 20 }])]);
    const r = await runReelPriceGuard({}, deps);
    expect(r.blocked[0].reason).toContain("introuvable");
  });

  it("never blocks on a Shopify read failure: reports it as unverified", async () => {
    live["830-001"] = new Error("timeout");
    deps.loadRows = vi.fn(async () => [row(9, [{ sku: "830-001", pct: 30 }])]);
    const r = await runReelPriceGuard({}, deps);
    expect(r.blocked).toEqual([]);
    expect(r.unverified[0].reason).toContain("timeout");
    expect(deps.blockRow).not.toHaveBeenCalled();
  });

  it("does not report a row that stopped being pending in the meantime", async () => {
    deps.blockRow = vi.fn(async () => false);
    deps.loadRows = vi.fn(async () => [row(10, [{ sku: "830-002", pct: 30 }])]);
    expect((await runReelPriceGuard({}, deps)).blocked).toEqual([]);
  });

  it("dry run writes nothing", async () => {
    deps.loadRows = vi.fn(async () => [row(11, [{ sku: "830-002", pct: 30 }])]);
    const r = await runReelPriceGuard({ dryRun: true }, deps);
    expect(r.blocked).toHaveLength(1);
    expect(deps.blockRow).not.toHaveBeenCalled();
    expect(deps.saveResult).not.toHaveBeenCalled();
  });

  it("reads each SKU once across Reels", async () => {
    deps.loadRows = vi.fn(async () => [row(1, [{ sku: "830-001", pct: 30 }]), row(2, [{ sku: "830-001", pct: 30 }])]);
    await runReelPriceGuard({}, deps);
    expect(deps.fetchVariant).toHaveBeenCalledTimes(1);
  });
});

describe("fetchVariantBySku", () => {
  beforeEach(() => shop.shopifyFetch.mockReset());
  const respond = (nodes: unknown[]) =>
    shop.shopifyFetch.mockResolvedValue({ ok: true, json: async () => ({ data: { productVariants: { nodes } } }) });

  it("returns the exact-SKU variant with its product status", async () => {
    respond([
      { sku: "830-0011", price: "1.00", compareAtPrice: null, availableForSale: true, product: { status: "ACTIVE" } },
      { sku: "830-001", price: "70.00", compareAtPrice: "100.00", availableForSale: true, product: { status: "ACTIVE" } },
    ]);
    expect(await fetchVariantBySku("830-001")).toEqual({ sku: "830-001", price: 70, compareAt: 100, availableForSale: true, productStatus: "ACTIVE" });
    const body = JSON.parse(shop.shopifyFetch.mock.calls[0][1].body);
    expect(body.variables.q).toBe('sku:"830-001"');
    expect(body.query).not.toMatch(/mutation/);
  });

  it("returns null when no variant carries that SKU, throws on an HTTP error", async () => {
    respond([]);
    expect(await fetchVariantBySku("X")).toBeNull();
    shop.shopifyFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchVariantBySku("X")).rejects.toThrow("503");
  });
});
