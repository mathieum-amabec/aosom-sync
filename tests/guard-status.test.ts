import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/database", () => ({ loadGuardInputs: vi.fn() }));
const { evaluateGuards, STALE_AFTER_SECS } = await import("@/lib/guard-status");
import type { GuardInputs } from "@/lib/database";

const NOW = 1_790_400_000;
const fresh = NOW - 3600;

function inputs(over: Partial<GuardInputs> = {}): GuardInputs {
  return {
    priceAudit: { auditedAt: fresh, total: 3099, belowFloor: 16, corrected: 16, failed: 0, deferred: 0 },
    catalogAudit: { auditedAt: fresh, totalActive: 1374, englishDescriptions: 0, brandLeaks: 0, duplicateColorOptions: 0, issues: [] },
    feedAudit: { auditedAt: fresh, ok: true, reasons: [], logic: { items: 2519, multiItems: 1681 } },
    lastRuns: {
      "price-audit": { status: "success", ranAt: fresh, detail: null },
      "catalog-consistency": { status: "success", ranAt: fresh, detail: null },
      "feed-integrity": { status: "success", ranAt: fresh, detail: null },
    },
    imagesPending: 0,
    imagesOldestPendingAt: null,
    ...over,
  };
}
const byKey = (i: GuardInputs) => Object.fromEntries(evaluateGuards(i, NOW).map((g) => [g.key, g]));

describe("evaluateGuards", () => {
  it("all clean → four green guards with a summary", () => {
    const g = byKey(inputs());
    expect(Object.values(g).map((x) => x.state)).toEqual(["green", "green", "green", "green"]);
    expect(g.price.summary).toBe("3099 prix vérifiés · 16 corrigés automatiquement");
    expect(g.catalog.summary).toBe("1374 fiches actives vérifiées");
    expect(g.feed.summary).toBe("2519 items vérifiés (1681 multi-variantes)");
  });

  it("price: auto-corrected below-floor prices stay green; a FAILED correction is red", () => {
    expect(byKey(inputs()).price.state).toBe("green");
    const g = byKey(inputs({ priceAudit: { auditedAt: fresh, total: 10, corrected: 1, failed: 2 } })).price;
    expect(g.state).toBe("red");
    expect(g.reasons[0]).toBe("2 corrections de prix plancher ont échoué — prix à corriger à la main");
  });

  it("catalog: any finding is red, with each kind counted", () => {
    const g = byKey(inputs({
      catalogAudit: { auditedAt: fresh, totalActive: 10, englishDescriptions: 1, brandLeaks: 0, duplicateColorOptions: 5 },
    })).catalog;
    expect(g.state).toBe("red");
    expect(g.reasons[0]).toBe("1 description en anglais · 5 fiches avec couleur en double");
  });

  it("images: a pending review is a decision waiting on Mat, with its age", () => {
    const g = byKey(inputs({ imagesPending: 1, imagesOldestPendingAt: NOW - 4 * 86400 })).images;
    expect(g.state).toBe("red");
    expect(g.reasons[0]).toBe("1 image attend ta décision (la plus ancienne depuis 4 j)");
  });

  it("feed: the audit's own reasons are surfaced verbatim", () => {
    const g = byKey(inputs({ feedAudit: { auditedAt: fresh, ok: false, reasons: ["le flux Google publié est vide"], logic: {} } })).feed;
    expect(g.state).toBe("red");
    expect(g.reasons).toEqual(["le flux Google publié est vide"]);
  });

  it("a guard that stopped running (result older than 36 h) is red even if its last result was clean", () => {
    const old = NOW - STALE_AFTER_SECS - 3600;
    const g = byKey(inputs({ catalogAudit: { auditedAt: old, totalActive: 10 } })).catalog;
    expect(g.state).toBe("red");
    expect(g.reasons[0]).toMatch(/^aucun résultat depuis 37 h — le garde-fou ne tourne plus$/);
  });

  it("a failed last run (newer than the stored result) is red with its error", () => {
    const g = byKey(inputs({
      lastRuns: { ...inputs().lastRuns, "price-audit": { status: "error", ranAt: NOW - 60, detail: "Shopify rate limit exceeded" } },
    })).price;
    expect(g.state).toBe("red");
    expect(g.reasons).toContain("le dernier passage a échoué (Shopify rate limit exceeded)");
  });

  it("an OLD failed run superseded by a newer successful result is not an alert", () => {
    const g = byKey(inputs({
      lastRuns: { ...inputs().lastRuns, "price-audit": { status: "error", ranAt: fresh - 86400, detail: "old" } },
    })).price;
    expect(g.state).toBe("green");
  });

  it("a guard that never ran is 'unknown', not red (e.g. the feed guard on its first day)", () => {
    const g = byKey(inputs({ feedAudit: null, lastRuns: { ...inputs().lastRuns, "feed-integrity": undefined as never } })).feed;
    expect(g.state).toBe("unknown");
    expect(g.reasons).toEqual([]);
  });
});
