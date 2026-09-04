import { describe, it, expect, vi } from "vitest";
import {
  SOCIAL_CATEGORIES,
  getCategory,
  isValidCategory,
  seasonalDefaultCategory,
  resolveCategory,
  THIN_POOL_THRESHOLD,
} from "@/lib/social-categories";

describe("social category table", () => {
  it("has unique keys and exactly one unfiltered entry", () => {
    const keys = SOCIAL_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SOCIAL_CATEGORIES.filter((c) => c.predicate === null)).toHaveLength(1);
    expect(SOCIAL_CATEGORIES[0].key).toBe("all");
  });

  it("covers all 13 categories the dashboard offers", () => {
    expect(SOCIAL_CATEGORIES.map((c) => c.key)).toEqual([
      "all", "halloween", "noel", "salon", "chambre", "bureau", "exterieur",
      "cuisine", "rangement", "enfants", "animaux", "solde", "nouveautes",
    ]);
  });

  it("every filtered category carries a non-empty French label and a predicate", () => {
    for (const c of SOCIAL_CATEGORIES) {
      expect(c.label.trim().length).toBeGreaterThan(0);
      if (c.key !== "all") expect(c.predicate).toBeTruthy();
    }
  });

  // The predicate is inlined into SQL by getEligibleHighlightCandidates, so it must never
  // be able to terminate the statement or smuggle a second one. These are constants in this
  // file, but the assertion is what keeps a future edit from turning that into an injection.
  it("no predicate can break out of the WHERE clause", () => {
    for (const c of SOCIAL_CATEGORIES) {
      if (!c.predicate) continue;
      expect(c.predicate).not.toMatch(/;|--|\/\*/);
      expect(c.args).toEqual([]);
    }
  });

  it("looks categories up by key and rejects unknown ones", () => {
    expect(getCategory("halloween")?.label).toBe("🎃 Halloween");
    expect(getCategory("nope")).toBeUndefined();
    expect(getCategory(null)).toBeUndefined();
    expect(isValidCategory("all")).toBe(true);
    expect(isValidCategory("noel")).toBe(true);
    expect(isValidCategory("Noel")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory(undefined)).toBe(false);
  });

  it("records a lifestyle pool no larger than the eligible pool", () => {
    for (const c of SOCIAL_CATEGORIES) {
      expect(c.measuredLifestylePool).toBeGreaterThanOrEqual(0);
      expect(c.measuredLifestylePool).toBeLessThanOrEqual(c.measuredPool);
    }
  });

  // Measured against live Shopify tags. On 2026-09-03 Halloween sat at 0 of 34 — the
  // Phase-3 classification campaign never reached that batch, so the category could only
  // ever fail. The 2026-09-04 pass (13 pos-1 swaps + 24 tags) took it to 34/34; this test
  // is what catches a regression back to the silent-failure state.
  it("knows halloween can post again, and that nouveautes still cannot", () => {
    expect(getCategory("halloween")!.measuredLifestylePool).toBe(
      getCategory("halloween")!.measuredPool,
    );
    expect(getCategory("nouveautes")!.measuredLifestylePool).toBe(0);
    expect(getCategory("exterieur")!.measuredLifestylePool).toBeGreaterThan(THIN_POOL_THRESHOLD);
  });

  // The 2026-09-04 tag-vs-product_type measurement, pinned so a future edit that switches
  // the seasonal categories to Shopify tags has to confront it. Tag matching pulls 15 extra
  // products into Noël (a cat house, a gazebo, ride-on cars tagged "cadeau Noël", and two
  // matching on "bois de sapin" — fir wood, not a tree). product_type does not.
  it("keeps the seasonal categories on product_type, not Shopify tags", () => {
    for (const key of ["halloween", "noel"]) {
      const c = getCategory(key)!;
      expect(c.predicate).toContain("product_type");
      expect(c.predicate).not.toContain("tag");
    }
  });
});

describe("seasonalDefaultCategory", () => {
  it.each([
    [1, "salon"], [2, "salon"],
    [3, null], [4, null], [5, null],
    [6, "exterieur"], [7, "exterieur"], [8, "exterieur"],
    [9, "halloween"], [10, "halloween"],
    [11, "noel"], [12, "noel"],
  ] as const)("month %i maps to %s", (month, expected) => {
    expect(seasonalDefaultCategory(month)).toBe(expected);
  });

  it("returns null for an out-of-range or non-integer month rather than throwing", () => {
    expect(seasonalDefaultCategory(0)).toBeNull();
    expect(seasonalDefaultCategory(13)).toBeNull();
    expect(seasonalDefaultCategory(-1)).toBeNull();
    expect(seasonalDefaultCategory(9.5)).toBeNull();
    expect(seasonalDefaultCategory(NaN)).toBeNull();
  });

  it("every month it names is a real category", () => {
    for (let m = 1; m <= 12; m++) {
      const key = seasonalDefaultCategory(m);
      if (key) expect(getCategory(key)).toBeDefined();
    }
  });

  it("defaults to the current month when none is passed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-15T12:00:00"));
      expect(seasonalDefaultCategory()).toBe("halloween");
      vi.setSystemTime(new Date("2026-12-01T12:00:00"));
      expect(seasonalDefaultCategory()).toBe("noel");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveCategory", () => {
  it("an explicit choice wins and is strict — no widening on a miss", () => {
    // September would otherwise be Halloween; the operator asked for animals.
    const r = resolveCategory("animaux", 9);
    expect(r.category?.key).toBe("animaux");
    expect(r.source).toBe("explicit");
    expect(r.canFallBack).toBe(false);
  });

  it("'all' means the whole catalog, overriding the season", () => {
    const r = resolveCategory("all", 10);
    expect(r.category).toBeNull();
    expect(r.source).toBe("none");
    expect(r.canFallBack).toBe(false);
  });

  it("no choice in a seasonal month is a soft preference", () => {
    for (const explicit of [null, undefined, ""] as const) {
      const r = resolveCategory(explicit, 10);
      expect(r.category?.key).toBe("halloween");
      expect(r.source).toBe("seasonal");
      expect(r.canFallBack).toBe(true);
    }
  });

  it("no choice out of season is the whole catalog", () => {
    const r = resolveCategory(null, 4);
    expect(r.category).toBeNull();
    expect(r.source).toBe("none");
    expect(r.canFallBack).toBe(false);
  });

  it("an unknown key never silently becomes a seasonal or catalog-wide run", () => {
    const r = resolveCategory("halloweeeen", 10);
    expect(r.category).toBeNull();
    expect(r.source).toBe("none");
    expect(r.canFallBack).toBe(false);
  });
});
