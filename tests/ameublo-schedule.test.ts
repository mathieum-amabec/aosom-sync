import { describe, it, expect } from "vitest";
import { parseAmeubloSchedule, ameubloScheduleForLang } from "@/lib/publication-scheduler";

describe("Studio Ameublo grid", () => {
  it("defaults to 8 Reels a day at fixed hours, every day", () => {
    const s = parseAmeubloSchedule(null);
    expect(s.max_per_day).toBe(8);
    expect(s.slots).toHaveLength(7);
    expect(s.slots[0].times).toEqual(["07:45", "09:45", "12:15", "14:30", "16:15", "18:30", "20:15", "21:45"]);
    expect(parseAmeubloSchedule("not json").max_per_day).toBe(8);
  });
  it("splits the day: FR gets the 1st, 3rd, 5th and 7th hour, EN the 2nd, 4th, 6th and 8th, 4 a day each", () => {
    const s = parseAmeubloSchedule(null);
    const fr = ameubloScheduleForLang(s, "fr");
    const en = ameubloScheduleForLang(s, "en");
    expect(fr.slots[0].times).toEqual(["07:45", "12:15", "16:15", "20:15"]);
    expect(en.slots[0].times).toEqual(["09:45", "14:30", "18:30", "21:45"]);
    expect(fr.max_per_day).toBe(4);
    expect(en.max_per_day).toBe(4);
  });
  it("a day with a single hour serves both languages", () => {
    const s = parseAmeubloSchedule(JSON.stringify({ enabled: true, timezone: "America/Toronto", max_per_day: 1, slots: [{ day: "mon", times: ["10:00"] }] }));
    expect(ameubloScheduleForLang(s, "fr").slots[0].times).toEqual(["10:00"]);
    expect(ameubloScheduleForLang(s, "en").slots[0].times).toEqual(["10:00"]);
  });
  it("keeps a stored cap above the social limit of 5", () => {
    const s = parseAmeubloSchedule(JSON.stringify({ enabled: true, timezone: "America/Toronto", max_per_day: 8, slots: [{ day: "mon", times: ["07:45", "09:45"] }] }));
    expect(s.max_per_day).toBe(8);
  });
});
