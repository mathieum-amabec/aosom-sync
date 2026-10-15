import { describe, it, expect, vi } from "vitest";
import {
  shouldUpdateSellPrice,
  planSellPrices,
  discountCap,
  runSellPriceSync,
  parsePricingMode,
  PRICING_PLAN_KEY,
  PRICING_MAX_CHANGES_KEY,
  type SellPriceDeps,
  type SellPriceRow,
} from "@/lib/sell-price-sync";
import { effectiveSellPrice } from "@/lib/pricing";
import { computeDiffs } from "@/lib/diff-engine";
import type { AosomMergedProduct } from "@/types/aosom";
import type { ShopifyExistingProduct } from "@/types/sync";

describe("effectiveSellPrice", () => {
  it("is the Aosom price when nothing is stored (pricing mode off): today's behaviour", () => {
    expect(effectiveSellPrice(99.99)).toBe(99.99);
    expect(effectiveSellPrice(99.99, null)).toBe(99.99);
  });
  it("uses a sane stored price", () => {
    expect(effectiveSellPrice(99.99, 106.99)).toBe(106.99);
  });
  it("never goes below the Aosom price, even if Aosom raised its price after the sell price was stored", () => {
    expect(effectiveSellPrice(120, 106.99)).toBe(120);
    expect(effectiveSellPrice(99.99, 90)).toBe(99.99);
  });
  it("ignores a corrupt stored price (more than 1.5x the Aosom price)", () => {
    expect(effectiveSellPrice(99.99, 500)).toBe(99.99);
  });
  it("is NaN for an invalid Aosom price so callers skip", () => {
    expect(effectiveSellPrice(0, 50)).toBeNaN();
    expect(effectiveSellPrice(NaN, 50)).toBeNaN();
  });
});

describe("shouldUpdateSellPrice (stability)", () => {
  it("sets an unset price and fixes one under the Aosom floor", () => {
    expect(shouldUpdateSellPrice(null, 106.99, 99.99)).toBe(true);
    expect(shouldUpdateSellPrice(90, 99.99, 99.99)).toBe(true);
  });
  it("follows a lower price at once", () => {
    expect(shouldUpdateSellPrice(110.99, 109.99, 99.99)).toBe(true);
  });
  it("raises only for a meaningful gain (>= max(2 $, 2 %))", () => {
    expect(shouldUpdateSellPrice(100.99, 101.99, 99.99)).toBe(false); // +1 $
    expect(shouldUpdateSellPrice(100.99, 102.99, 99.99)).toBe(false); // +2 $ but just under 2 % (2.02 $)
    expect(shouldUpdateSellPrice(100.99, 103.99, 99.99)).toBe(true); // +3 $
    expect(shouldUpdateSellPrice(500.99, 508.99, 450)).toBe(false); // +8 $ but under 2 % of 500 (10 $)
    expect(shouldUpdateSellPrice(500.99, 511.99, 450)).toBe(true);
  });
  it("does nothing when the price is the same", () => {
    expect(shouldUpdateSellPrice(106.99, 106.99, 99.99)).toBe(false);
  });
});

const row = (sku: string, aosomPrice: number, sellPrice: number | null = null, productType = "Home Furnishings"): SellPriceRow => ({ sku, aosomPrice, productType, sellPrice });

describe("planSellPrices", () => {
  it("prices a product a dollar under the competitor", () => {
    const comp = new Map([["A", 258.99]]);
    const p = planSellPrices([row("A", 239.99)], comp);
    expect(p.changes).toEqual([expect.objectContaining({ sku: "A", from: null, to: 257.99, reason: "competitor" })]);
  });

  it("falls back to the tiers when the competitor does not carry the SKU", () => {
    const p = planSellPrices([row("B", 60.99)], new Map([["OTHER", 10]]));
    expect(p.changes[0]).toMatchObject({ sku: "B", to: 64.99, reason: "tier" });
  });

  it("leaves existing prices alone when no competitor data is available at all, but still prices unset ones", () => {
    const p = planSellPrices([row("A", 239.99, 257.99), row("B", 60.99, null)], null);
    expect(p.changes.map((c) => c.sku)).toEqual(["B"]);
    expect(p.unchanged).toBe(1);
  });

  it("matches competitor SKUs case-insensitively", () => {
    const p = planSellPrices([row("ab-1", 100.99)], new Map([["AB-1", 112.99]]));
    expect(p.changes[0].reason).toBe("competitor");
  });

  it("counts an invalid Aosom price instead of pricing it", () => {
    const p = planSellPrices([row("X", 0), row("Y", NaN)], null);
    expect(p.invalid).toBe(2);
    expect(p.changes).toHaveLength(0);
  });

  it("caps the changes per run: under-floor fixes first, then decreases, then products with no price, then the largest raises", () => {
    const rows = [
      row("RAISE_SMALL", 100, 100.99), // would go to ~106.99 (raise of 6)
      row("RAISE_BIG", 300, 300.99), // tier 6 % -> ~317.99 (raise of 17)
      row("DROP", 100, 120.99), // competitor lower -> a decrease
      row("UNSET", 100, null),
      row("UNDER", 100, 90), // stored price under the Aosom floor
    ];
    const comp = new Map([["DROP", 111.99]]);
    const p = planSellPrices(rows, comp, 4);
    expect(p.changes.map((c) => c.sku)).toEqual(["UNDER", "DROP", "UNSET", "RAISE_BIG"]);
    expect(p.deferred).toBe(1);
  });

  it("never lets a fix queue behind new work: with a cap of 1 a decrease beats any number of unset products", () => {
    const rows = [row("U1", 100, null), row("U2", 200, null), row("FIX", 100, 120.99)];
    const p = planSellPrices(rows, new Map([["FIX", 111.99]]), 1);
    expect(p.changes.map((c) => c.sku)).toEqual(["FIX"]);
  });
});

function makeDeps(over: { rows?: SellPriceRow[]; settings?: Record<string, string>; comp?: Map<string, number> | null } = {}) {
  const store: Record<string, string> = { ...(over.settings ?? {}) };
  const deps: SellPriceDeps = {
    now: () => new Date("2026-10-15T08:15:00Z"),
    getSetting: async (k) => store[k] ?? null,
    setSetting: async (k, v) => { store[k] = v; },
    loadRows: async () => over.rows ?? [row("A", 239.99), row("B", 60.99)],
    loadCompetitor: async () => ({ prices: over.comp === undefined ? new Map([["A", 258.99]]) : over.comp, source: over.comp === null ? "none" : "fresh" }),
    saveChanges: vi.fn(async () => {}),
  };
  return { deps, store };
}

describe("runSellPriceSync", () => {
  it("does nothing while off (the default)", async () => {
    const { deps } = makeDeps();
    const r = await runSellPriceSync({ deps });
    expect(r.skipped).toBe("off");
    expect(deps.saveChanges).not.toHaveBeenCalled();
  });

  it("dry mode stores a summary and writes no price", async () => {
    const { deps, store } = makeDeps({ settings: { pricing_mode: "dry" } });
    const r = await runSellPriceSync({ deps });
    expect(r.skipped).toBe("dry-run");
    expect(r.plan.changes).toHaveLength(2);
    expect(deps.saveChanges).not.toHaveBeenCalled();
    expect(JSON.parse(store[PRICING_PLAN_KEY]).changes).toBe(2);
  });

  it("live mode saves the changes", async () => {
    const { deps } = makeDeps({ settings: { pricing_mode: "live" } });
    const r = await runSellPriceSync({ deps });
    expect(r.applied).toBe(2);
    expect(deps.saveChanges).toHaveBeenCalledTimes(1);
  });

  it("honours the per-run cap setting", async () => {
    const { deps } = makeDeps({ settings: { pricing_mode: "live", [PRICING_MAX_CHANGES_KEY]: "1" } });
    const r = await runSellPriceSync({ deps });
    expect(r.applied).toBe(1);
    expect(r.plan.deferred).toBe(1);
  });

  it("skips when there are no products", async () => {
    const { deps } = makeDeps({ settings: { pricing_mode: "live" }, rows: [] });
    expect((await runSellPriceSync({ deps })).skipped).toBe("no-products");
  });
});

describe("parsePricingMode", () => {
  it("defaults to off for anything unknown", () => {
    expect(parsePricingMode(null)).toBe("off");
    expect(parsePricingMode("on")).toBe("off");
    expect(parsePricingMode("dry")).toBe("dry");
    expect(parsePricingMode("live")).toBe("live");
  });
});

// ── diff-engine reads the stored sell price ───────────────────────────────────────────────

function aosom(): AosomMergedProduct {
  return {
    groupKey: "G", name: "Test", brand: "Aosom", productType: "Test", category: "Test", description: "<p>d</p>", shortDescription: "s", material: "m",
    images: ["https://img.com/1.jpg"], video: "", pdf: "",
    variants: [{ sku: "TEST-001", price: 99.99, qty: 20, color: "Noir", size: "", gtin: "", weight: 5, dimensions: { length: 1, width: 1, height: 1 }, images: ["https://img.com/1.jpg"], estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "" }],
  };
}
function shopify(price = 99.99): ShopifyExistingProduct {
  return {
    shopifyId: "S1", title: "Test", status: "active", bodyHtml: "<p>d</p>", productType: "Test", images: ["https://img.com/1.jpg"], tags: ["back-in-stock"],
    variants: [{ variantId: "V1", sku: "TEST-001", price, inventoryQuantity: 17, inventoryItemId: "I1", option1: "Noir", option2: null, option3: null }],
  } as unknown as ShopifyExistingProduct;
}
const priceChange = (sp?: ReadonlyMap<string, number>, shopPrice = 99.99) =>
  computeDiffs([aosom()], [shopify(shopPrice)], sp).flatMap((d) => d.changes).find((c) => c.field === "price");

describe("computeDiffs with a stored sell price", () => {
  it("emits no price change with no stored price and Shopify at the Aosom price (mode off)", () => {
    expect(priceChange()).toBeUndefined();
  });
  it("moves Shopify to the stored sell price", () => {
    const c = priceChange(new Map([["TEST-001", 106.99]]));
    expect(c).toMatchObject({ oldValue: 99.99, newValue: 106.99 });
  });
  it("never targets a price below the Aosom price, even with a stale stored one", () => {
    expect(priceChange(new Map([["TEST-001", 90]]), 90)).toMatchObject({ newValue: 99.99 });
  });
  it("ignores a corrupt stored price", () => {
    expect(priceChange(new Map([["TEST-001", 999]]))).toBeUndefined();
  });
});

describe("planSellPrices keeps an existing discount (maxPrice)", () => {
  it("caps the sell price so the product stays at least 10 % under its reference price", () => {
    // Aosom 94.99 with a real reference of 109.99 -> max 98.99; the rule alone would go to 100.99 (tier 7 %)
    const rows: SellPriceRow[] = [{ sku: "D", aosomPrice: 94.99, productType: "Home Furnishings", sellPrice: null, maxPrice: 109.99 * 0.9 }];
    const p = planSellPrices(rows, new Map());
    expect(p.changes[0].to).toBe(98.99);
    expect(p.changes[0].to).toBeLessThanOrEqual(109.99 * 0.9);
  });

  it("never goes below the Aosom floor, whatever the cap", () => {
    const rows: SellPriceRow[] = [{ sku: "D", aosomPrice: 100, productType: "Home Furnishings", sellPrice: null, maxPrice: 90 }];
    const p = planSellPrices(rows, new Map());
    expect(p.changes[0].to).toBe(100);
    expect(p.changes[0].reason).toBe("floor");
  });

  it("lowers a price that was already raised above the cap", () => {
    const rows: SellPriceRow[] = [{ sku: "D", aosomPrice: 94.99, productType: "Home Furnishings", sellPrice: 105.99, maxPrice: 98.99 }];
    const p = planSellPrices(rows, new Map());
    expect(p.changes[0]).toMatchObject({ from: 105.99, to: 98.99 });
  });

  it("does not touch a product with no cap", () => {
    const rows: SellPriceRow[] = [{ sku: "D", aosomPrice: 94.99, productType: "Home Furnishings", sellPrice: null, maxPrice: null }];
    expect(planSellPrices(rows, new Map()).changes[0].to).toBe(100.99); // 94.99 x 1.07 = 101.64, rounded down to .99
  });
});

describe("discountCap", () => {
  const keep = 0.9;
  it("caps at 90 % of a reference the Aosom price is already 10 % under", () => {
    expect(discountCap(94.99, [109.99], keep)).toBeCloseTo(98.991, 3);
  });
  it("ignores a reference with no real discount to protect (Aosom price is within 10 % of it)", () => {
    expect(discountCap(100, [105], keep)).toBeNull();
  });
  it("takes the tightest of several references and skips missing ones", () => {
    expect(discountCap(80, [null, 120, 100, undefined], keep)).toBeCloseTo(90, 5);
  });
  it("protects a displayed crossed price even with no price history", () => {
    expect(discountCap(94.99, [null, 109.99], keep)).toBeCloseTo(98.991, 3);
  });
  it("returns null when nothing needs protecting", () => {
    expect(discountCap(94.99, [null, undefined], keep)).toBeNull();
  });
});
