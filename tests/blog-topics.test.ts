import { describe, it, expect } from "vitest";
import {
  BILINGUAL_TOPICS,
  isoWeekNumber,
  isoWeekKey,
  extractKeywords,
  selectBilingualTopic,
  seasonOf,
  isSeasonActive,
  isTopicInSeason,
  type Season,
} from "@/lib/blog-topics";

const VALID_SEASONS: Season[] = ["spring", "summer", "fall", "winter", "all"];

describe("BILINGUAL_TOPICS catalogue", () => {
  it("has at least 30 bilingual topics", () => {
    expect(BILINGUAL_TOPICS.length).toBeGreaterThanOrEqual(30);
  });

  it("has no duplicate FR, EN, or imageQuery entries", () => {
    const fr = BILINGUAL_TOPICS.map((t) => t.fr);
    const en = BILINGUAL_TOPICS.map((t) => t.en);
    const iq = BILINGUAL_TOPICS.map((t) => t.imageQuery);
    expect(new Set(fr).size).toBe(fr.length);
    expect(new Set(en).size).toBe(en.length);
    expect(new Set(iq).size).toBe(iq.length);
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

  it("every entry has a valid season tag", () => {
    for (const t of BILINGUAL_TOPICS) {
      expect(VALID_SEASONS).toContain(t.season);
    }
  });
});

describe("seasonOf", () => {
  it("maps months to spring/summer/fall/winter (0-indexed)", () => {
    expect([0, 1].map(seasonOf)).toEqual(["winter", "winter"]); // Jan, Feb
    expect([2, 3, 4].map(seasonOf)).toEqual(["spring", "spring", "spring"]); // Mar-May
    expect([5, 6, 7].map(seasonOf)).toEqual(["summer", "summer", "summer"]); // Jun-Aug
    expect([8, 9, 10].map(seasonOf)).toEqual(["fall", "fall", "fall"]); // Sep-Nov
    expect(seasonOf(11)).toBe("winter"); // Dec
  });
});

describe("isSeasonActive / isTopicInSeason", () => {
  const jan = new Date("2026-01-15T12:00:00Z"); // winter
  const jul = new Date("2026-07-15T12:00:00Z"); // summer

  it("evergreen ('all') is active in every season", () => {
    expect(isSeasonActive("all", jan)).toBe(true);
    expect(isSeasonActive("all", jul)).toBe(true);
  });

  it("a seasonal tag is active only in its season", () => {
    expect(isSeasonActive("summer", jul)).toBe(true);
    expect(isSeasonActive("summer", jan)).toBe(false);
    expect(isSeasonActive("winter", jan)).toBe(true);
    expect(isSeasonActive("winter", jul)).toBe(false);
  });

  it("isTopicInSeason gates a summer patio topic out of January", () => {
    const summerTopic = BILINGUAL_TOPICS.find((t) => t.season === "summer")!;
    expect(isTopicInSeason(summerTopic, jul)).toBe(true);
    expect(isTopicInSeason(summerTopic, jan)).toBe(false);
  });
});

describe("isoWeekKey", () => {
  it("formats as YYYY-Www with a zero-padded week", () => {
    expect(isoWeekKey(new Date("2021-01-04T00:00:00Z"))).toBe("2021-W01");
  });

  it("is stable within a week and changes across weeks", () => {
    const mon = new Date("2026-06-08T00:00:00Z");
    const wed = new Date("2026-06-10T00:00:00Z");
    const nextMon = new Date("2026-06-15T00:00:00Z");
    expect(isoWeekKey(mon)).toBe(isoWeekKey(wed));
    expect(isoWeekKey(mon)).not.toBe(isoWeekKey(nextMon));
  });

  it("uses the ISO-week year at the Dec/Jan boundary (no phantom key)", () => {
    // 2025-12-31 is a Wednesday belonging to ISO week 2026-W01.
    expect(isoWeekKey(new Date("2025-12-31T00:00:00Z"))).toBe("2026-W01");
    // 2026-01-01 (Thursday) is the same ISO week → same key, so the cap counter is shared.
    expect(isoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
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

  it("carries the selected topic's season", () => {
    const sel = selectBilingualTopic(new Date("2026-03-01T12:00:00Z"));
    expect(sel.season).toBe(BILINGUAL_TOPICS[sel.idx].season);
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

  // Rotation is per RUN, not per week: the cron fires twice a week (Mon + Thu) and the index
  // advances by one each time. Sampling one run per week would step by 2 and — with an even
  // catalogue size — only ever reach half the topics, which is why this walks both runs.
  it("rotates through every topic across consecutive runs, no repeats within a cycle", () => {
    const seen = new Set<number>();
    const base = Date.UTC(2026, 2, 2); // Monday, March 2 2026 (mid-year, no ISO year wrap)
    for (let i = 0; i < BILINGUAL_TOPICS.length / 2; i++) {
      const monday = new Date(base + i * 7 * 86_400_000);
      const thursday = new Date(base + i * 7 * 86_400_000 + 3 * 86_400_000);
      seen.add(selectBilingualTopic(monday).idx);
      seen.add(selectBilingualTopic(thursday).idx);
    }
    expect(seen.size).toBe(BILINGUAL_TOPICS.length);
  });
});

describe("selectBilingualTopic — run slot (Mon vs Thu collision)", () => {
  // Regression: the cron fires Mon + Thu, and BOTH land in the same ISO week. When the topic
  // index was derived from the week number alone, the two runs picked the SAME topic and
  // published duplicate articles to a live storefront.
  it("gives Monday and Thursday of the same ISO week DIFFERENT topics", () => {
    const mon = selectBilingualTopic(new Date("2026-08-10T08:00:00Z")); // ISO week 33
    const thu = selectBilingualTopic(new Date("2026-08-13T08:00:00Z")); // same ISO week

    expect(mon.week).toBe(thu.week); // same week — this is the trap
    expect(mon.slot).toBe(0);
    expect(thu.slot).toBe(1);
    expect(mon.idx).not.toBe(thu.idx);
    expect(mon.fr).not.toBe(thu.fr);
    expect(mon.en).not.toBe(thu.en);
  });

  it("assigns Mon-Wed to slot 0 and Thu-Sun to slot 1", () => {
    const slotFor = (iso: string) => selectBilingualTopic(new Date(iso)).slot;
    expect(slotFor("2026-08-10T08:00:00Z")).toBe(0); // Mon
    expect(slotFor("2026-08-11T08:00:00Z")).toBe(0); // Tue
    expect(slotFor("2026-08-12T08:00:00Z")).toBe(0); // Wed
    expect(slotFor("2026-08-13T08:00:00Z")).toBe(1); // Thu
    expect(slotFor("2026-08-14T08:00:00Z")).toBe(1); // Fri
    expect(slotFor("2026-08-15T08:00:00Z")).toBe(1); // Sat
    expect(slotFor("2026-08-16T08:00:00Z")).toBe(1); // Sun
  });

  it("advances the index by exactly one between consecutive runs", () => {
    // week*2+slot is a true sequential run counter: Mon(w)=2w, Thu(w)=2w+1, Mon(w+1)=2w+2.
    // That +1 step is what guarantees full catalogue coverage regardless of catalogue parity.
    const monA = selectBilingualTopic(new Date("2026-08-10T08:00:00Z"));
    const thuA = selectBilingualTopic(new Date("2026-08-13T08:00:00Z"));
    const monB = selectBilingualTopic(new Date("2026-08-17T08:00:00Z"));

    const len = BILINGUAL_TOPICS.length;
    expect((thuA.idx - monA.idx + len) % len).toBe(1);
    expect((monB.idx - thuA.idx + len) % len).toBe(1);
  });

  it("stays deterministic for a given date", () => {
    const a = selectBilingualTopic(new Date("2026-08-13T08:00:00Z"));
    const b = selectBilingualTopic(new Date("2026-08-13T23:59:00Z"));
    expect(a.idx).toBe(b.idx);
    expect(a.slot).toBe(b.slot);
  });
});
