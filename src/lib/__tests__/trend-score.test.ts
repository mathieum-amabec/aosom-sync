import { describe, it, expect } from "vitest";
import {
  percentile,
  containment,
  scoreProducts,
  collectionMatches,
  aggregateCollections,
  DEFAULT_TREND_WEIGHTS,
  DISCOUNT_ANCHOR_PCT,
  TILE_COUNT,
  MAX_TILES_PER_ROOT,
  type ScoredProduct,
} from "@/lib/trend-score";

/** A candidate row shaped like the one `fetchCandidates` returns. */
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    sku: "SKU-1",
    product_type: "Home Furnishings > Living Room Furniture",
    shopify_product_id: "111",
    shopify_handle: "a-product",
    qty: 10,
    price: 100,
    velocity: 10,
    compare_at_price: null,
    ...over,
  } as Parameters<typeof scoreProducts>[0][number];
}

describe("percentile — nearest-rank on an ascending array", () => {
  it("returns 0 for an empty array so callers can divide safely", () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it("picks the nearest rank, not an interpolated value", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 0.5)).toBe(5);
    expect(percentile(xs, 0.99)).toBe(10);
    expect(percentile(xs, 0)).toBe(1);
  });
});

describe("scoreProducts — the composite model", () => {
  it("scores a product with no velocity and no rabais at zero, and drops it", () => {
    const out = scoreProducts([row({ velocity: 0, compare_at_price: null })]);
    expect(out).toHaveLength(0);
  });

  it("gives the p99 velocity product a full velocity component", () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ sku: `S${i}`, velocity: i + 1, compare_at_price: null }),
    );
    const out = scoreProducts(rows);
    const best = out[0];
    expect(best.velocityNorm).toBeCloseTo(1, 5);
    expect(best.score).toBeCloseTo(DEFAULT_TREND_WEIGHTS.velocity, 5);
  });

  it("log-scales velocity so the top of the ranking is not saturated", () => {
    // Linear/p95 normalisation pinned a wide band of products at exactly 1.0,
    // which handed the ordering to the discount alone. Only the very top may sit
    // at 1.0 now.
    const rows = Array.from({ length: 100 }, (_, i) =>
      row({ sku: `S${i}`, velocity: i + 1, compare_at_price: null }),
    );
    const out = scoreProducts(rows);
    const saturated = out.filter((p) => p.velocityNorm >= 1);
    expect(saturated.length).toBeLessThanOrEqual(2);
    // …and the mid-pack still carries a meaningful, non-zero component.
    const median = out[Math.floor(out.length / 2)];
    expect(median.velocityNorm).toBeGreaterThan(0.5);
    expect(median.velocityNorm).toBeLessThan(1);
  });

  it("ignores a rabais below the store's ≥10% rule", () => {
    // 100 vs 105 compare-at is under 10% off — no badge, and no price signal.
    const out = scoreProducts([row({ price: 100, compare_at_price: 105, velocity: 1 })]);
    expect(out[0].discountPct).toBe(0);
    expect(out[0].discountNorm).toBe(0);
  });

  it("counts a rabais at or above 10%, and caps the component at the fixed anchor", () => {
    const [half] = scoreProducts([row({ price: 100, compare_at_price: 200, velocity: 1 })]);
    // 50% off is the anchor → a full discount component.
    expect(half.discountPct).toBe(DISCOUNT_ANCHOR_PCT);
    expect(half.discountNorm).toBeCloseTo(1, 5);

    const [deeper] = scoreProducts([row({ price: 10, compare_at_price: 100, velocity: 1 })]);
    // 90% off cannot score more than 1.0.
    expect(deeper.discountNorm).toBe(1);
  });

  it("lets a deeply-discounted slow mover out-rank a fast mover at list price", () => {
    const rows = [
      ...Array.from({ length: 98 }, (_, i) => row({ sku: `F${i}`, velocity: i + 1 })),
      row({ sku: "SLOW-BIG-RABAIS", velocity: 4, price: 50, compare_at_price: 120 }),
      row({ sku: "FAST-NO-RABAIS", velocity: 40, compare_at_price: null }),
    ];
    const out = scoreProducts(rows);
    const slow = out.find((p) => p.sku === "SLOW-BIG-RABAIS")!;
    const fast = out.find((p) => p.sku === "FAST-NO-RABAIS")!;
    expect(slow.score).toBeGreaterThan(fast.score);
  });

  it("honours custom weights", () => {
    const rows = [row({ velocity: 10, price: 100, compare_at_price: 200 })];
    const [only] = scoreProducts(rows, { velocity: 0, discount: 1 });
    expect(only.score).toBeCloseTo(only.discountNorm, 5);
  });

  it("returns products sorted best-first", () => {
    const out = scoreProducts([
      row({ sku: "LOW", velocity: 1 }),
      row({ sku: "HIGH", velocity: 50 }),
      row({ sku: "MID", velocity: 10 }),
    ]);
    expect(out.map((p) => p.sku)).toEqual(["HIGH", "MID", "LOW"]);
  });
});

describe("collectionMatches — Shopify `type` rule semantics", () => {
  const set = (over: Partial<Parameters<typeof collectionMatches>[1]> = {}) =>
    ({
      collectionId: "1",
      handle: "h",
      title: "T",
      disjunctive: false,
      rules: [{ relation: "contains" as const, condition: "Patio & Garden" }],
      ...over,
    }) as Parameters<typeof collectionMatches>[1];

  it("matches case-insensitively on a substring", () => {
    expect(collectionMatches("Patio & Garden > Fire Pits", set())).toBe(true);
    expect(collectionMatches("patio & garden > fire pits", set())).toBe(true);
    expect(collectionMatches("Home Furnishings > Sofas", set())).toBe(false);
  });

  it("ANDs rules by default and ORs them when disjunctive", () => {
    const rules = [
      { relation: "contains" as const, condition: "Home Furnishings" },
      { relation: "not_contains" as const, condition: "Appliances" },
    ];
    expect(collectionMatches("Home Furnishings > Sofas", set({ rules }))).toBe(true);
    expect(collectionMatches("Home Furnishings > Appliances > Fans", set({ rules }))).toBe(false);
    expect(
      collectionMatches("Home Furnishings > Appliances > Fans", set({ rules, disjunctive: true })),
    ).toBe(true);
  });

  it("never matches an empty product_type", () => {
    expect(collectionMatches("", set())).toBe(false);
  });
});

describe("containment — |A∩B| / min(|A|,|B|)", () => {
  it("is 1.0 when one set is a subset of the other", () => {
    expect(containment(new Set(["a", "b"]), new Set(["a", "b", "c", "d"]))).toBe(1);
  });

  it("is 0 for disjoint sets and for an empty set", () => {
    expect(containment(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(containment(new Set(), new Set(["b"]))).toBe(0);
  });
});

describe("aggregateCollections — tile selection", () => {
  /** n scored products of one root category, descending scores. */
  function products(prefix: string, root: string, n: number, base: number): ScoredProduct[] {
    return Array.from({ length: n }, (_, i) => ({
      sku: `${prefix}-${i}`,
      productType: `${root} > ${prefix}`,
      shopifyProductId: `${prefix}${i}`,
      shopifyHandle: `${prefix}-${i}`,
      qty: 5,
      price: 100,
      compareAtPrice: null,
      velocity: 1,
      discountPct: 0,
      velocityNorm: 0,
      discountNorm: 0,
      score: base - i * 0.001,
    }));
  }

  const set = (handle: string, condition: string) => ({
    collectionId: handle,
    handle,
    title: handle,
    disjunctive: false,
    rules: [{ relation: "contains" as const, condition }],
  });

  it("drops a collection below the 3-product floor", () => {
    const out = aggregateCollections(products("tiny", "Root", 2, 0.9), [set("tiny", "tiny")]);
    expect(out).toHaveLength(0);
  });

  it("scores a collection as the mean of its top 5, not a sum", () => {
    // 10 products all at 0.5 → mean stays 0.5 however many there are.
    const ps = products("a", "Root", 10, 0.5).map((p) => ({ ...p, score: 0.5 }));
    const [c] = aggregateCollections(ps, [set("a", "a")]);
    expect(c.score).toBeCloseTo(0.5, 6);
    expect(c.productCount).toBe(10);
  });

  it("refuses a tile to a collection contained in a better-scoring one", () => {
    // "desks" ⊃ "computer-desks": every computer desk is also a desk.
    const ps = [
      ...products("desks", "Office Products", 10, 0.9),
      ...products("computerdesks", "Office Products", 4, 0.88),
    ];
    const out = aggregateCollections(ps, [
      set("desks", "desks"),
      // matches BOTH prefixes, so its membership contains the other's
      set("all-desks", "desks"),
    ]);
    const tiled = out.filter((c) => c.tileRank !== null);
    expect(tiled).toHaveLength(1);
    expect(out.find((c) => c.tileRank === null)).toBeDefined();
  });

  it("caps tiles at two per top-level category", () => {
    const sets: ReturnType<typeof set>[] = [];
    const ps: ScoredProduct[] = [];
    for (let i = 0; i < 5; i++) {
      ps.push(...products(`office${i}`, "Office Products", 4, 0.9 - i * 0.01));
      sets.push(set(`office${i}`, `office${i}`));
    }
    const out = aggregateCollections(ps, sets);
    const tiled = out.filter((c) => c.tileRank !== null);
    expect(tiled).toHaveLength(MAX_TILES_PER_ROOT);
    expect(tiled.every((c) => c.rootCategory === "Office Products")).toBe(true);
  });

  it("never stamps more than TILE_COUNT tiles, and ranks them 0..n-1 in score order", () => {
    const sets: ReturnType<typeof set>[] = [];
    const ps: ScoredProduct[] = [];
    // 12 disjoint collections across 12 distinct roots, so nothing is filtered
    // out by overlap or the per-root cap.
    for (let i = 0; i < 12; i++) {
      ps.push(...products(`c${i}`, `Root${i}`, 4, 0.9 - i * 0.01));
      sets.push(set(`c${i}`, `c${i}`));
    }
    const tiled = aggregateCollections(ps, sets)
      .filter((c) => c.tileRank !== null)
      .sort((a, b) => (a.tileRank as number) - (b.tileRank as number));
    expect(tiled).toHaveLength(TILE_COUNT);
    expect(tiled.map((c) => c.tileRank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let i = 1; i < tiled.length; i++) {
      expect(tiled[i - 1].score).toBeGreaterThanOrEqual(tiled[i].score);
    }
  });

  it("does not leak the working membership set into its result", () => {
    const [c] = aggregateCollections(products("a", "Root", 5, 0.5), [set("a", "a")]);
    expect(c).not.toHaveProperty("memberSkus");
  });
});
