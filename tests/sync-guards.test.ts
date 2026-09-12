/**
 * Unit tests for the two sync circuit breakers (src/lib/sync-guards.ts).
 *
 * Every case here is anchored on the 2026-09-12 incident: a frozen CSV cache made Phase 1
 * see zero changes, `last_seen_at` went un-stamped for the whole catalogue, and Phase 2
 * read the empty "seen today" set as "Aosom withdrew everything" and drafted 30 live
 * products at 10 a run. The numbers used below (8,018 feed / 1,382 active / 1,349
 * archives) are the real ones from that morning.
 */
import { describe, it, expect } from "vitest";
import {
  assertFeedPlausible,
  guardMassArchive,
  ImplausibleFeedError,
  FEED_MIN_ABSOLUTE,
  ARCHIVE_MIN_ABSOLUTE,
} from "@/lib/sync-guards";

const FEED_BASELINE = 8_018; // totalProducts of the last good Phase 1 run
const ACTIVE_SHOPIFY = 1_382; // active products in the store that morning

type Diff = { groupKey: string; action: "update" | "archive" };
const isArchive = (d: Diff) => d.action === "archive";
const archives = (n: number): Diff[] =>
  Array.from({ length: n }, (_, i) => ({ groupKey: `arch-${i}`, action: "archive" as const }));
const updates = (n: number): Diff[] =>
  Array.from({ length: n }, (_, i) => ({ groupKey: `upd-${i}`, action: "update" as const }));

describe("assertFeedPlausible — Phase 1 refuses a feed it cannot believe", () => {
  it("accepts a normal feed", () => {
    expect(() => assertFeedPlausible(8_018, FEED_BASELINE)).not.toThrow();
  });

  it("accepts the ordinary drift that broke csv-precache (7,962 vs an 8,000 floor)", () => {
    // The whole incident started because a hardcoded floor sat just above the live
    // catalogue size. A relative guard must not repeat that mistake.
    expect(() => assertFeedPlausible(7_962, FEED_BASELINE)).not.toThrow();
  });

  it("accepts a large but believable shrink (60% of baseline)", () => {
    expect(() => assertFeedPlausible(Math.floor(FEED_BASELINE * 0.6), FEED_BASELINE)).not.toThrow();
  });

  it("rejects an empty feed", () => {
    expect(() => assertFeedPlausible(0, FEED_BASELINE)).toThrow(ImplausibleFeedError);
  });

  it("rejects a feed under half the last good run", () => {
    expect(() => assertFeedPlausible(3_000, FEED_BASELINE)).toThrow(/under 50%/);
  });

  it("rejects an empty feed even with no history to compare against", () => {
    expect(() => assertFeedPlausible(FEED_MIN_ABSOLUTE - 1)).toThrow(/came back empty/);
    expect(() => assertFeedPlausible(0)).toThrow(ImplausibleFeedError);
  });

  it("lets a genuinely small catalogue through on a first-ever run (no baseline)", () => {
    // With no history there is nothing to call "too small" — a fixed floor here would be
    // the same mistake csv-precache made with its `min 8000`, just in a new place.
    expect(() => assertFeedPlausible(50)).not.toThrow();
    expect(() => assertFeedPlausible(50, 0)).not.toThrow();
    expect(() => assertFeedPlausible(50, undefined)).not.toThrow();
  });

  it("carries the counts on the error so the operator sees both numbers", () => {
    try {
      assertFeedPlausible(12, FEED_BASELINE);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImplausibleFeedError);
      expect((err as ImplausibleFeedError).feedCount).toBe(12);
      expect((err as ImplausibleFeedError).baselineCount).toBe(FEED_BASELINE);
    }
  });
});

describe("guardMassArchive — Phase 2 refuses to archive the catalogue", () => {
  it("blocks the exact shape of the incident: 1,349 archives against 1,382 active", () => {
    const diffs = [...archives(1_349), ...updates(5)];
    const res = guardMassArchive(diffs, ACTIVE_SHOPIFY, isArchive);

    expect(res.tripped).toBe(true);
    expect(res.blocked).toHaveLength(1_349);
    expect(res.reason).toMatch(/BLOCKED/);
  });

  it("lets price/stock diffs through while archives are blocked", () => {
    // The point of the split: a poisoned archive set must not cost the store a day of
    // stale prices. Everything that is not an archive still runs.
    const diffs = [...archives(1_349), ...updates(7)];
    const res = guardMassArchive(diffs, ACTIVE_SHOPIFY, isArchive);

    expect(res.allowed).toHaveLength(7);
    expect(res.allowed.every((d) => d.action === "update")).toBe(true);
  });

  it("does not fire on the normal rhythm of real removals (0-10 a day)", () => {
    for (const n of [0, 1, 5, 10]) {
      const res = guardMassArchive([...archives(n), ...updates(20)], ACTIVE_SHOPIFY, isArchive);
      expect(res.tripped, `${n} archives should pass`).toBe(false);
      expect(res.blocked).toHaveLength(0);
      expect(res.allowed).toHaveLength(n + 20);
    }
  });

  it("passes a genuine bulk cleanup that stays under the ceiling", () => {
    // 5% of 1,382 = 69. A real 60-product category withdrawal must still apply.
    const res = guardMassArchive(archives(60), ACTIVE_SHOPIFY, isArchive);
    expect(res.tripped).toBe(false);
    expect(res.allowed).toHaveLength(60);
  });

  it("fires one product past the ceiling", () => {
    const threshold = Math.floor(ACTIVE_SHOPIFY * 0.05); // 69
    expect(guardMassArchive(archives(threshold), ACTIVE_SHOPIFY, isArchive).tripped).toBe(false);
    expect(guardMassArchive(archives(threshold + 1), ACTIVE_SHOPIFY, isArchive).tripped).toBe(true);
  });

  it("never blocks below the absolute minimum, however small the store", () => {
    // A 40-product store would otherwise have a ceiling of 2, tripping on routine churn.
    const res = guardMassArchive(archives(ARCHIVE_MIN_ABSOLUTE), 40, isArchive);
    expect(res.tripped).toBe(false);
    expect(res.threshold).toBe(ARCHIVE_MIN_ABSOLUTE);
  });

  it("still guards when Shopify returns nothing (the degenerate case)", () => {
    // activeShopifyCount = 0 must not mean "ceiling 0, block everything" nor
    // "ratio undefined, allow everything" — the absolute minimum governs.
    expect(guardMassArchive(archives(5), 0, isArchive).tripped).toBe(false);
    expect(guardMassArchive(archives(500), 0, isArchive).tripped).toBe(true);
  });

  it("reports the threshold it applied", () => {
    const res = guardMassArchive(archives(1_349), ACTIVE_SHOPIFY, isArchive);
    expect(res.threshold).toBe(69);
    expect(res.reason).toContain("69");
    expect(res.reason).toContain("1349");
  });
});
