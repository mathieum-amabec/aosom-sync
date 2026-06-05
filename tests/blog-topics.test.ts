import { describe, it, expect } from "vitest";
import {
  BILINGUAL_TOPICS,
  isoWeekNumber,
  extractKeywords,
  selectBilingualTopic,
} from "@/lib/blog-topics";

describe("BILINGUAL_TOPICS catalogue", () => {
  it("has at least 12 bilingual topics", () => {
    expect(BILINGUAL_TOPICS.length).toBeGreaterThanOrEqual(12);
  });

  it("every entry has a non-empty FR, EN, and imageQuery", () => {
    for (const t of BILINGUAL_TOPICS) {
      expect(t.fr.trim().length).toBeGreaterThan(0);
      expect(t.en.trim().length).toBeGreaterThan(0);
      expect(t.imageQuery.trim().length).toBeGreaterThan(0);
    }
  });

  it("FR and EN of an entry are distinct strings (real translations, not duplicates)", () => {
    for (const t of BILINGUAL_TOPICS) {
      expect(t.fr).not.toBe(t.en);
    }
  });
});

describe("isoWeekNumber", () => {
  it("returns ISO week 1 for 2021-01-04 (a Monday)", () => {
    expect(isoWeekNumber(new Date("2021-01-04T00:00:00Z"))).toBe(1);
  });

  it("returns ISO week 53 for 2020-12-31", () => {
    expect(isoWeekNumber(new Date("2020-12-31T00:00:00Z"))).toBe(53);
  });

  it("always returns a value in the valid ISO week range", () => {
    for (let day = 0; day < 366; day++) {
      const d = new Date(Date.UTC(2026, 0, 1 + day));
      const w = isoWeekNumber(d);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(53);
    }
  });
});

describe("extractKeywords", () => {
  it("drops stopwords and keeps up to 3 keywords", () => {
    const kw = extractKeywords("Aménager un salon cosy et chaleureux", "fr");
    expect(kw.length).toBeLessThanOrEqual(3);
    expect(kw).not.toContain("un");
    expect(kw).not.toContain("et");
  });

  it("dedupes and lowercases", () => {
    const kw = extractKeywords("Sofa SOFA sofa comfort", "en");
    const sofaCount = kw.filter((k) => k === "sofa").length;
    expect(sofaCount).toBeLessThanOrEqual(1);
  });
});

describe("selectBilingualTopic — synchronization guarantees", () => {
  it("reads FR and EN from the SAME catalogue index (same subject)", () => {
    const sel = selectBilingualTopic(new Date("2026-03-01T12:00:00Z"));
    expect(sel.idx).toBeGreaterThanOrEqual(0);
    expect(sel.idx).toBeLessThan(BILINGUAL_TOPICS.length);
    expect(sel.fr).toBe(BILINGUAL_TOPICS[sel.idx].fr);
    expect(sel.en).toBe(BILINGUAL_TOPICS[sel.idx].en);
  });

  it("shares one image query across FR and EN", () => {
    const sel = selectBilingualTopic(new Date("2026-03-01T12:00:00Z"));
    expect(sel.imageQuery).toBe(BILINGUAL_TOPICS[sel.idx].imageQuery);
  });

  it("derives non-empty per-language keyword sets", () => {
    const sel = selectBilingualTopic(new Date("2026-03-01T12:00:00Z"));
    expect(sel.keywordsFr.length).toBeGreaterThan(0);
    expect(sel.keywordsEn.length).toBeGreaterThan(0);
    expect(sel.keywordsFr.length).toBeLessThanOrEqual(3);
    expect(sel.keywordsEn.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic for a given date", () => {
    const a = selectBilingualTopic(new Date("2026-06-09T11:00:00Z"));
    const b = selectBilingualTopic(new Date("2026-06-09T11:00:00Z"));
    expect(a).toEqual(b);
  });

  it("rotates the topic across consecutive weeks (12 distinct indices)", () => {
    const seen = new Set<number>();
    const base = Date.UTC(2026, 2, 1); // March 1 2026, mid-year (no year wrap)
    for (let i = 0; i < BILINGUAL_TOPICS.length; i++) {
      const d = new Date(base + i * 7 * 86_400_000);
      seen.add(selectBilingualTopic(d).idx);
    }
    expect(seen.size).toBe(BILINGUAL_TOPICS.length);
  });
});
