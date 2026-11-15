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
  runIndexOf,
  slotStartOf,
  SEASONAL_SELECTOR_GO_LIVE,
  type Season,
} from "@/lib/blog-topics";

const VALID_SEASONS: Season[] = ["spring", "summer", "fall", "winter", "holidays", "cold", "outdoor", "all"];

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

  it("carries the topic's collection (and title pattern) when it has one", () => {
    const sel = selectBilingualTopic(new Date("2026-11-16T08:00:00Z"));
    const t = BILINGUAL_TOPICS[sel.idx];
    expect(sel.collection).toBe(t.collection);
    expect(sel.productTitlePattern).toBe(t.productTitlePattern);
  });
});

/** The cron dates (Mon + Thu 08:00 UTC) of `weeks` consecutive weeks starting at Monday `startIso`. */
function cronRuns(startIso: string, weeks: number): Date[] {
  const base = Date.parse(startIso);
  const out: Date[] = [];
  for (let w = 0; w < weeks; w++) {
    out.push(new Date(base + w * 7 * 86_400_000));
    out.push(new Date(base + (w * 7 + 3) * 86_400_000));
  }
  return out;
}

describe("BILINGUAL_TOPICS — commercial seasonal topics", () => {
  const byCollection = (c: string) => BILINGUAL_TOPICS.filter((t) => t.collection === c);

  it("covers the fall/winter buying needs with real collections", () => {
    for (const c of [
      "noel-sapins",
      "noel-decorations",
      "foyers-interieurs",
      "rangement-poufs-bancs",
      "cuisine-tables-a-manger",
      "fauteuils-et-canapes",
      "arbres-a-chat",
      "bureau-et-travail",
    ]) {
      expect(byCollection(c).some((t) => !t.retired && isSeasonActive(t.season, new Date("2026-12-01T08:00:00Z")) && t.season !== "all"), c).toBe(true);
    }
  });

  it("covers the spring/summer buying needs with real collections", () => {
    for (const c of ["patio-mobilier", "gazebos-et-pergolas", "patio-remises-jardin"]) {
      expect(byCollection(c).some((t) => !t.retired && t.season !== "all" && t.season !== "cold" && t.season !== "holidays"), c).toBe(true);
    }
  });

  it("has no broad duplicate of an existing article (narrow angles; gift ideas removed)", () => {
    const fr = BILINGUAL_TOPICS.map((t) => t.fr);
    expect(fr.some((t) => /idées cadeaux/i.test(t))).toBe(false); // guides/idees-cadeaux-noel-2026
    expect(fr).not.toContain("Choisir le bon sapin de Noël artificiel"); // guides/choisir-sapin-noel-artificiel-2026
    const sapin = BILINGUAL_TOPICS.find((t) => t.collection === "noel-sapins")!;
    expect(sapin.productTitlePattern).toBe("crayon|mince|étroit");
    // every active seasonal topic has a product filter or a collection narrow enough to stay on-angle
    for (const t of BILINGUAL_TOPICS.filter((x) => x.season === "holidays" || x.season === "cold" || x.season === "outdoor")) {
      expect(t.collection, t.fr).toBeTruthy();
    }
  });

  it("sofa-bed pattern matches 'lit' only as a word", () => {
    const t = BILINGUAL_TOPICS.find((x) => x.fr.includes("canapé-lit"))!;
    const re = new RegExp(t.productTitlePattern!, "i");
    expect(re.test("Canapé-lit convertible")).toBe(true);
    expect(re.test("Fauteuil inclinable en velours")).toBe(false);
    expect(re.test("Lot de 2 chaises éclairées")).toBe(false);
  });

  it("collection handles are Shopify-handle shaped and title patterns compile", () => {
    for (const t of BILINGUAL_TOPICS) {
      if (t.collection) expect(t.collection).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      for (const r of t.relatedCollections ?? []) expect(r).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      if (t.productTitlePattern) expect(() => new RegExp(t.productTitlePattern!, "i")).not.toThrow();
    }
  });

  it("holiday window is Nov 1 - Dec 20; cold is Nov-Feb; outdoor is Apr-Aug", () => {
    expect(isSeasonActive("holidays", new Date("2026-10-31T12:00:00Z"))).toBe(false);
    expect(isSeasonActive("holidays", new Date("2026-11-01T12:00:00Z"))).toBe(true);
    expect(isSeasonActive("holidays", new Date("2026-12-20T12:00:00Z"))).toBe(true);
    expect(isSeasonActive("holidays", new Date("2026-12-21T12:00:00Z"))).toBe(false);
    expect(isSeasonActive("cold", new Date("2027-02-28T12:00:00Z"))).toBe(true);
    expect(isSeasonActive("cold", new Date("2027-03-01T12:00:00Z"))).toBe(false);
    expect(isSeasonActive("outdoor", new Date("2027-03-31T12:00:00Z"))).toBe(false);
    expect(isSeasonActive("outdoor", new Date("2027-04-01T12:00:00Z"))).toBe(true);
    expect(isSeasonActive("outdoor", new Date("2027-09-01T12:00:00Z"))).toBe(false);
  });
});

describe("selectBilingualTopic — season-first selection", () => {
  it("prefers in-season seasonal topics: the first November runs are holiday topics", () => {
    const runs = cronRuns("2026-11-16T08:00:00Z", 2).map(selectBilingualTopic);
    for (const s of runs) expect(s.season).toBe("holidays");
    // shortest window first, then catalogue order → the Christmas tree guide opens the season
    expect(runs[0].collection).toBe("noel-sapins");
  });

  it("serves every in-season seasonal topic before falling back to evergreen", () => {
    // Nov 16 → Dec 14 (9 runs): 4 holiday + 5 cold topics exist.
    const sels = cronRuns("2026-11-16T08:00:00Z", 5).slice(0, 9).map(selectBilingualTopic);
    expect(sels.every((s) => s.season !== "all")).toBe(true);
    expect(new Set(sels.map((s) => s.idx)).size).toBe(sels.length);
    const holidayIdx = BILINGUAL_TOPICS.map((t, i) => (t.season === "holidays" ? i : -1)).filter((i) => i >= 0);
    for (const i of holidayIdx) expect(sels.map((s) => s.idx)).toContain(i);
  });

  it("falls back to evergreen once the season's topics are used, without repeating a seasonal topic", () => {
    // Nov 16 2026 → Feb 25 2027: far more runs than cold/holiday/winter topics.
    const sels = cronRuns("2026-11-16T08:00:00Z", 15).map(selectBilingualTopic);
    const seasonal = sels.filter((s) => s.season !== "all");
    expect(new Set(seasonal.map((s) => s.idx)).size).toBe(seasonal.length); // each at most once
    expect(sels.some((s) => s.season === "all")).toBe(true); // evergreen fallback happened
    // ...and the evergreen fallback rotates (no evergreen repeated within this window either).
    const evergreen = sels.filter((s) => s.season === "all");
    expect(new Set(evergreen.map((s) => s.idx)).size).toBe(evergreen.length);
  });

  it("never selects an out-of-season topic, all year round", () => {
    for (const d of cronRuns("2026-11-16T08:00:00Z", 60)) {
      const s = selectBilingualTopic(d);
      expect(isTopicInSeason(BILINGUAL_TOPICS[s.idx], d), `${d.toISOString()} → ${s.fr}`).toBe(true);
    }
  });

  it("never gives the Mon and Thu runs of a week the same topic", () => {
    const sels = cronRuns("2026-11-16T08:00:00Z", 60).map(selectBilingualTopic);
    for (let i = 0; i < sels.length; i += 2) {
      expect(sels[i].week).toBe(sels[i + 1].week);
      expect(sels[i].idx).not.toBe(sels[i + 1].idx);
    }
  });

  it("brings the spring/summer commercial topics in their season", () => {
    const march = cronRuns("2027-03-01T08:00:00Z", 2).map(selectBilingualTopic);
    expect(march.slice(0, 2).every((s) => s.season === "spring")).toBe(true); // March opens with spring topics
    const warm = cronRuns("2027-03-01T08:00:00Z", 17).map(selectBilingualTopic); // Mar → Jun
    expect(warm.map((s) => s.collection)).toEqual(
      expect.arrayContaining(["patio-remises-jardin", "patio-mobilier", "gazebos-et-pergolas"]),
    );
  });

  it("never selects a retired topic (a live article already covers it)", () => {
    const retired = new Set(BILINGUAL_TOPICS.map((t, i) => (t.retired ? i : -1)).filter((i) => i >= 0));
    expect(retired.size).toBeGreaterThan(0);
    for (const d of cronRuns("2026-11-16T08:00:00Z", 60)) expect(retired.has(selectBilingualTopic(d).idx)).toBe(false);
  });

  it("seeds the history with the legacy round-robin, so recently published evergreen topics do not come back in late December", () => {
    // Legacy formula (isoWeek*2+slot)%30 published idx 28 on 2026-10-26, 0 on 11-02, 3 on 11-12.
    const dec24 = selectBilingualTopic(new Date("2026-12-24T08:00:00Z"));
    expect(dec24.idx).not.toBe(0);
    expect(dec24.idx).not.toBe(3);
    const lateDec = cronRuns("2026-12-14T08:00:00Z", 3).map((d) => selectBilingualTopic(d).idx);
    for (const i of [0, 3, 28]) expect(lateDec).not.toContain(i);
  });

  it("slotStartOf returns the Monday (Mon-Wed) or Thursday (Thu-Sun) at 00:00 UTC", () => {
    expect(slotStartOf(new Date("2026-11-18T15:00:00Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(slotStartOf(new Date("2026-11-16T08:00:00Z")).toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(slotStartOf(new Date("2026-11-19T08:00:00Z")).toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(slotStartOf(new Date("2026-11-22T23:00:00Z")).toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("is deterministic per run slot (any time / weekday inside the slot gives the same topic)", () => {
    const mon = selectBilingualTopic(new Date("2026-11-23T08:00:00Z"));
    const tue = selectBilingualTopic(new Date("2026-11-24T19:00:00Z"));
    const thu = selectBilingualTopic(new Date("2026-11-26T08:00:00Z"));
    const sun = selectBilingualTopic(new Date("2026-11-29T23:00:00Z"));
    expect(tue.idx).toBe(mon.idx);
    expect(sun.idx).toBe(thu.idx);
  });

  it("runIndexOf advances by one per run", () => {
    const r = runIndexOf(new Date("2026-11-16T08:00:00Z"));
    expect(runIndexOf(new Date("2026-11-19T08:00:00Z"))).toBe(r + 1);
    expect(runIndexOf(new Date("2026-11-23T08:00:00Z"))).toBe(r + 2);
    expect(runIndexOf(SEASONAL_SELECTOR_GO_LIVE)).toBe(r);
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

  it("advances the run counter by exactly one between consecutive runs", () => {
    const monA = selectBilingualTopic(new Date("2026-08-10T08:00:00Z"));
    const thuA = selectBilingualTopic(new Date("2026-08-13T08:00:00Z"));
    const monB = selectBilingualTopic(new Date("2026-08-17T08:00:00Z"));
    expect(thuA.run).toBe(monA.run + 1);
    expect(monB.run).toBe(thuA.run + 1);
    expect(new Set([monA.idx, thuA.idx, monB.idx]).size).toBe(3);
  });

  it("stays deterministic for a given date", () => {
    const a = selectBilingualTopic(new Date("2026-08-13T08:00:00Z"));
    const b = selectBilingualTopic(new Date("2026-08-13T23:59:00Z"));
    expect(a.idx).toBe(b.idx);
    expect(a.slot).toBe(b.slot);
  });
});
