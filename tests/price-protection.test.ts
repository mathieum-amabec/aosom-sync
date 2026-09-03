import { describe, it, expect, vi } from "vitest";
import {
  isPriceSpike,
  priceChangePercent,
  computeDrift,
  pickSample,
  writePriceVerified,
  formatDriftAlert,
  formatWriteFailureAlert,
  formatSpikeAlert,
  PRICE_WRITE_ATTEMPTS,
  PRICE_SPIKE_THRESHOLD,
} from "@/lib/price-protection";

const noSleep = async () => {};

describe("LAYER 5 — isPriceSpike", () => {
  it("trips above +20% and not at or below it", () => {
    expect(isPriceSpike(100, 120)).toBe(false); // exactly +20% is allowed through
    expect(isPriceSpike(100, 120.01)).toBe(true);
    expect(isPriceSpike(100, 200)).toBe(true);
    expect(PRICE_SPIKE_THRESHOLD).toBe(0.2);
  });

  it("NEVER holds a price DROP, however large", () => {
    // Holding a drop is the failure this whole module exists to stop: it leaves us more
    // expensive than the supplier, which the floor audit will never correct.
    expect(isPriceSpike(200, 100)).toBe(false);
    expect(isPriceSpike(100, 1)).toBe(false);
  });

  it("ignores garbage input instead of drafting the product", () => {
    for (const [a, b] of [[0, 100], [-5, 100], [100, 0], [NaN, 100], [100, NaN], [Infinity, 100]]) {
      expect(isPriceSpike(a as number, b as number)).toBe(false);
    }
  });

  it("does not trip on the real 830-821V80BK move that started this work", () => {
    // 119,99 → 135,99 is +13,3% — a normal supplier reprice that must go live, not be held.
    expect(isPriceSpike(119.99, 135.99)).toBe(false);
    expect(priceChangePercent(119.99, 135.99)).toBe(13.3);
  });

  it("reports a negative percent for a drop", () => {
    expect(priceChangePercent(109.99, 104.99)).toBe(-4.5);
    expect(priceChangePercent(0, 50)).toBe(0);
  });
});

describe("LAYER 2/4 — computeDrift", () => {
  const variants = [
    { sku: "A", price: 119.99, variantId: "v1" },
    { sku: "B", price: 109.99, variantId: "v2" },
    { sku: "C", price: 50.0, variantId: "v3" },
  ];

  it("flags both directions, worst underpricing first", () => {
    const expected = new Map([["A", 135.99], ["B", 104.99], ["C", 50.0]]);
    const d = computeDrift(expected, variants);
    expect(d.map((x) => x.sku)).toEqual(["A", "B"]); // C matches, excluded
    expect(d[0]).toMatchObject({ sku: "A", gap: -16 }); // selling 16$ too cheap — listed first
    expect(d[1]).toMatchObject({ sku: "B", gap: 5 }); // selling 5$ too dear
  });

  it("ignores a Shopify variant with no Turso row — never touch a manual product", () => {
    expect(computeDrift(new Map(), variants)).toEqual([]);
  });

  it("ignores an expected price that is zero, negative or non-finite", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(computeDrift(new Map([["A", bad]]), variants)).toEqual([]);
    }
  });

  it("treats a sub-cent difference as equal (float round-trip noise)", () => {
    expect(computeDrift(new Map([["A", 119.995]]), variants)).toEqual([]);
  });

  it("skips variants with an empty SKU", () => {
    expect(computeDrift(new Map([["", 10]]), [{ sku: "", price: 1, variantId: "v" }])).toEqual([]);
  });
});

describe("pickSample", () => {
  it("returns everything when the pool is smaller than the sample", () => {
    expect(pickSample([1, 2, 3], 50)).toEqual([1, 2, 3]);
  });

  it("returns exactly `size` distinct items from a bigger pool", () => {
    const pool = Array.from({ length: 500 }, (_, i) => i);
    const s = pickSample(pool, 50);
    expect(s).toHaveLength(50);
    expect(new Set(s).size).toBe(50); // no duplicates
  });

  it("is deterministic when the RNG is", () => {
    const pool = Array.from({ length: 100 }, (_, i) => i);
    const seeded = () => 0.5;
    expect(pickSample(pool, 10, seeded)).toEqual(pickSample(pool, 10, seeded));
  });

  it("does not mutate the caller's array", () => {
    const pool = [1, 2, 3, 4, 5];
    pickSample(pool, 2);
    expect(pool).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("LAYER 1 — writePriceVerified", () => {
  it("confirms on the first attempt when the read-back matches", async () => {
    const writePrice = vi.fn().mockResolvedValue(undefined);
    const readVariant = vi.fn().mockResolvedValue({ price: 135.99 });
    const r = await writePriceVerified("A", "v1", 135.99, 119.99, { writePrice, readVariant, sleep: noSleep });
    expect(r).toMatchObject({ ok: true, attempts: 1, observed: 135.99 });
    expect(writePrice).toHaveBeenCalledTimes(1);
    expect(readVariant).toHaveBeenCalledTimes(1);
  });

  it("retries when Shopify accepts the PUT but stores a different price", async () => {
    // The exact failure that made price_history rows say applied_to_shopify=1 for prices
    // that were never live: the PUT returns 200, the value does not stick.
    const writePrice = vi.fn().mockResolvedValue(undefined);
    const readVariant = vi
      .fn()
      .mockResolvedValueOnce({ price: 119.99 })
      .mockResolvedValueOnce({ price: 135.99 });
    const r = await writePriceVerified("A", "v1", 135.99, undefined, { writePrice, readVariant, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("gives up after PRICE_WRITE_ATTEMPTS and reports the mismatch", async () => {
    const writePrice = vi.fn().mockResolvedValue(undefined);
    const readVariant = vi.fn().mockResolvedValue({ price: 119.99 });
    const r = await writePriceVerified("A", "v1", 135.99, undefined, { writePrice, readVariant, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(PRICE_WRITE_ATTEMPTS);
    expect(writePrice).toHaveBeenCalledTimes(PRICE_WRITE_ATTEMPTS);
    expect(r.error).toMatch(/read-back mismatch/);
  });

  it("retries a throwing write, then succeeds", async () => {
    const writePrice = vi.fn().mockRejectedValueOnce(new Error("429 throttled")).mockResolvedValue(undefined);
    const readVariant = vi.fn().mockResolvedValue({ price: 135.99 });
    const r = await writePriceVerified("A", "v1", 135.99, undefined, { writePrice, readVariant, sleep: noSleep });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("fails FAST on a deleted variant — retrying a 404 never succeeds", async () => {
    const writePrice = vi.fn().mockResolvedValue(undefined);
    const readVariant = vi.fn().mockResolvedValue(null);
    const r = await writePriceVerified("A", "v1", 135.99, undefined, { writePrice, readVariant, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1); // did NOT burn all three
    expect(writePrice).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/not found/);
  });

  it("accepts a read-back within one cent", async () => {
    const writePrice = vi.fn().mockResolvedValue(undefined);
    const readVariant = vi.fn().mockResolvedValue({ price: 135.9899 });
    const r = await writePriceVerified("A", "v1", 135.99, undefined, { writePrice, readVariant, sleep: noSleep });
    expect(r.ok).toBe(true);
  });
});

describe("LAYER 3 — alert formatting", () => {
  it("splits drift into under and over priced, and caps the list", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      sku: `S${i}`, variantId: `v${i}`, shopifyPrice: 100, expectedPrice: i < 15 ? 120 : 80, gap: i < 15 ? -20 : 20,
    }));
    const a = formatDriftAlert(items, "test");
    expect(a.title).toContain("25 variante(s)");
    expect(a.message).toContain("15 sous le prix attendu");
    expect(a.message).toContain("10 au-dessus");
    expect(a.message).toContain("et 5 autre(s)");
  });

  it("names the SKU, both prices and the retry count on a write failure", () => {
    const a = formatWriteFailureAlert([
      { sku: "830-821V80BK", variantId: "43126871851113", requested: 135.99, observed: 119.99, ok: false, attempts: 3, error: "read-back mismatch" },
    ]);
    expect(a.title).toContain("1 variante(s)");
    expect(a.message).toContain("830-821V80BK");
    expect(a.message).toContain("135.99");
    expect(a.message).toContain("119.99");
    expect(a.message).toContain(String(PRICE_WRITE_ATTEMPTS));
  });

  it("states the percentage and that the product was drafted", () => {
    const a = formatSpikeAlert([{ sku: "X", shopifyId: "123", oldPrice: 100, newPrice: 150 }]);
    expect(a.title).toContain("20 %");
    expect(a.message).toContain("50 %");
    expect(a.message).toContain("draft");
    expect(a.message).toContain("123");
  });
});
