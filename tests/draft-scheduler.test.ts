import { describe, it, expect } from "vitest";
import {
  upcomingSlots,
  findSlot,
  buildOccupancy,
  langsOf,
  POSTING_WEEKDAYS_UTC,
  SLOT_HOUR_UTC,
} from "@/lib/draft-scheduler";

const sec = (y: number, m: number, d: number, h = 0, min = 0) => Math.floor(Date.UTC(y, m, d, h, min, 0) / 1000);
// 2026-01-05 is a Monday. M/W/F that week: Mon 5, Wed 7, Fri 9.
const MON = sec(2026, 0, 5);
const WED_SLOT = sec(2026, 0, 7, SLOT_HOUR_UTC);
const FRI_SLOT = sec(2026, 0, 9, SLOT_HOUR_UTC);
const MON_SLOT = sec(2026, 0, 5, SLOT_HOUR_UTC);

describe("upcomingSlots", () => {
  it("returns Mon/Wed/Fri at 15:00 UTC, in order", () => {
    expect(upcomingSlots(MON, 3)).toEqual([MON_SLOT, WED_SLOT, FRI_SLOT]);
  });

  it("only ever returns posting weekdays at 15:00:00 UTC (skips Tue/Thu/Sat/Sun)", () => {
    for (const s of upcomingSlots(MON, 20)) {
      const d = new Date(s * 1000);
      expect(POSTING_WEEKDAYS_UTC).toContain(d.getUTCDay());
      expect(d.getUTCHours()).toBe(SLOT_HOUR_UTC);
      expect(d.getUTCMinutes()).toBe(0);
      expect(d.getUTCSeconds()).toBe(0);
    }
  });

  it("returns strictly-increasing slots", () => {
    const s = upcomingSlots(MON, 10);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });

  it("excludes the same-day slot once 15:00 UTC has passed", () => {
    // Monday 15:30 UTC → Monday's 15:00 slot is in the past, so first is Wednesday.
    expect(upcomingSlots(sec(2026, 0, 5, 15, 30), 1)[0]).toBe(WED_SLOT);
  });

  it("from a weekend lands on the next Monday", () => {
    // 2026-01-10 is a Saturday → next slot is Mon 2026-01-12 15:00 UTC.
    expect(upcomingSlots(sec(2026, 0, 10), 1)[0]).toBe(sec(2026, 0, 12, SLOT_HOUR_UTC));
  });
});

describe("findSlot — per-language capacity (1 FR + 1 EN per slot)", () => {
  const bilingual = { fr: true, en: true };

  it("puts a bilingual draft in the first slot when all are empty", () => {
    expect(findSlot(MON, bilingual, new Map())).toBe(MON_SLOT);
  });

  it("rolls a bilingual draft to the next slot when the first is full (fr+en taken)", () => {
    const occ = new Map([[MON_SLOT, { fr: 1, en: 1 }]]);
    expect(findSlot(MON, bilingual, occ)).toBe(WED_SLOT);
  });

  it("lets an EN-only draft share a slot that already has an FR post", () => {
    const occ = new Map([[MON_SLOT, { fr: 1, en: 0 }]]);
    expect(findSlot(MON, { fr: false, en: true }, occ)).toBe(MON_SLOT);
  });

  it("rolls an FR-only draft past a slot whose FR capacity is used", () => {
    const occ = new Map([[MON_SLOT, { fr: 1, en: 0 }]]);
    expect(findSlot(MON, { fr: true, en: false }, occ)).toBe(WED_SLOT);
  });

  it("returns null for a draft with no languages", () => {
    expect(findSlot(MON, { fr: false, en: false }, new Map())).toBeNull();
  });

  it("skips two consecutive full slots", () => {
    const occ = new Map([
      [MON_SLOT, { fr: 1, en: 1 }],
      [WED_SLOT, { fr: 1, en: 1 }],
    ]);
    expect(findSlot(MON, bilingual, occ)).toBe(FRI_SLOT);
  });
});

describe("buildOccupancy", () => {
  it("counts FR and EN posts per slot and ignores null timestamps", () => {
    const occ = buildOccupancy([
      { scheduledAt: MON_SLOT, fr: true, en: true },
      { scheduledAt: MON_SLOT, fr: true, en: false },
      { scheduledAt: WED_SLOT, fr: false, en: true },
      { scheduledAt: null, fr: true, en: true },
    ]);
    expect(occ.get(MON_SLOT)).toEqual({ fr: 2, en: 1 });
    expect(occ.get(WED_SLOT)).toEqual({ fr: 0, en: 1 });
    expect(occ.has(0)).toBe(false);
  });
});

describe("langsOf", () => {
  it("detects FR/EN presence and treats blank/whitespace as absent", () => {
    expect(langsOf("Bonjour", "Hello")).toEqual({ fr: true, en: true });
    expect(langsOf("Bonjour", "")).toEqual({ fr: true, en: false });
    expect(langsOf("   ", null)).toEqual({ fr: false, en: false });
    expect(langsOf(null, "Hello")).toEqual({ fr: false, en: true });
  });
});
