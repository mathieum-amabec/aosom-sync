import { describe, it, expect } from "vitest";
import { planWeek, isGridSlot, isSeasonalVideo, isSeasonalActive, type PlanCandidate } from "@/lib/ameublo-week-plan";

// Tuesday 2026-10-06 00:30 Toronto (04:30 UTC): the whole of Oct 6 is still ahead.
const NOW = Math.floor(Date.parse("2026-10-06T04:30:00Z") / 1000);
let n = 0;
const v = (lang: "fr" | "en", style: string, o: Partial<PlanCandidate> = {}): PlanCandidate => ({
  id: ++n, lang, style, campaign: null, series: "Série", label: `${style} ${n}`, ...o,
});
const hw = (lang: "fr" | "en", style: string) => v(lang, style, { campaign: "halloween-2026" });

describe("planWeek", () => {
  it("books FR at :00-ish and EN 5 minutes later, in Toronto time (EDT = UTC-4)", () => {
    const plan = planWeek({ candidates: [v("fr", "vitrine"), v("en", "vitrine"), v("fr", "astuce"), v("en", "astuce")], occupied: [], nowSec: NOW, days: 1 });
    const times = plan.map((p) => `${p.lang} ${p.at.slice(11, 16)}`);
    expect(times).toContain("fr 11:45"); // 07:45 Toronto
    expect(times).toContain("en 11:50"); // 07:50 Toronto
  });

  it("never plans two videos on the same slot, and keeps languages apart", () => {
    const cands = [...Array.from({ length: 10 }, () => v("fr", "vitrine")), ...Array.from({ length: 10 }, () => v("en", "top3"))];
    const plan = planWeek({ candidates: cands, occupied: [], nowSec: NOW, days: 4 });
    expect(new Set(plan.map((p) => p.at)).size).toBe(plan.length);
    for (const p of plan) expect(cands.find((c) => c.id === p.id)!.lang).toBe(p.lang);
  });

  it("puts seasonal videos first, and only seasonal videos on the 06:00 slot", () => {
    const cands = [v("fr", "astuce"), v("fr", "vitrine"), hw("fr", "reaction"), hw("fr", "top3")];
    const plan = planWeek({ candidates: cands, occupied: [], nowSec: NOW, days: 1 });
    const s0 = plan.find((p) => p.slot === "S0")!;
    expect(s0.seasonal).toBe(true);
    expect(s0.at.slice(11, 16)).toBe("10:00"); // 06:00 Toronto
    expect(plan.filter((p) => p.slot === "S0" && !p.seasonal)).toHaveLength(0);
    // the regular videos still get slots (the educational rail keeps non-seasonal ones)
    expect(plan.find((p) => p.slot === "S1")!.seasonal).toBe(false);
  });

  it("leaves slots that are already occupied alone", () => {
    const first = planWeek({ candidates: [v("fr", "vitrine")], occupied: [], nowSec: NOW, days: 1 })[0];
    const again = planWeek({ candidates: [v("fr", "vitrine")], occupied: [first.at], nowSec: NOW, days: 1 })[0];
    expect(again.at).not.toBe(first.at);
  });

  it("skips the seasonal slot after the season ends", () => {
    const after = Math.floor(Date.parse("2026-11-03T14:00:00Z") / 1000);
    expect(isSeasonalActive(after)).toBe(false);
    const plan = planWeek({ candidates: [hw("fr", "reaction")], occupied: [], nowSec: after, days: 2 });
    expect(plan.every((p) => p.slot !== "S0")).toBe(true);
  });

  it("prefers the rail's style for the weekday (Wednesday noon = Top 3 before Vitrine)", () => {
    const vitrine = v("fr", "vitrine"); // older id, would win a plain FIFO
    const top3 = v("fr", "top3");
    const plan = planWeek({ candidates: [vitrine, top3], occupied: [], nowSec: NOW + 86400, days: 1 }); // Wednesday 2026-10-07
    const noon = plan.find((p) => p.slot === "S2")!;
    expect(noon.at).toBe("2026-10-07 16:15:00"); // 12:15 Toronto
    expect(noon.id).toBe(top3.id);
  });

  it("returns nothing when there is nothing to plan", () => {
    expect(planWeek({ candidates: [], occupied: [], nowSec: NOW })).toEqual([]);
  });

  it("detects seasonal videos from the campaign or the series/label", () => {
    expect(isSeasonalVideo({ campaign: "halloween-2026", series: "x", label: null })).toBe(true);
    expect(isSeasonalVideo({ campaign: null, series: "Pub Halloween Costway", label: null })).toBe(true);
    expect(isSeasonalVideo({ campaign: "maison-2026", series: "x", label: "Canapé" })).toBe(false);
  });
});

describe("isGridSlot", () => {
  it("accepts grid slots of the right language only", () => {
    expect(isGridSlot("fr", "2026-10-06 11:45:00", NOW)).toBe(true);
    expect(isGridSlot("en", "2026-10-06 11:50:00", NOW)).toBe(true);
    expect(isGridSlot("fr", "2026-10-06 11:50:00", NOW)).toBe(false); // EN time
    expect(isGridSlot("fr", "2026-10-06 11:46:00", NOW)).toBe(false);
  });
  it("closes the 06:00 slot once the season is over", () => {
    const after = Math.floor(Date.parse("2026-11-03T14:00:00Z") / 1000);
    expect(isGridSlot("fr", "2026-11-04 11:00:00", after)).toBe(false); // 06:00 Toronto in EST = 11:00 UTC
    expect(isGridSlot("fr", "2026-10-06 10:00:00", NOW)).toBe(true);
  });
});
