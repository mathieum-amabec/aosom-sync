import { describe, it, expect } from "vitest";
import { parseAmeubloSchedule, ameubloScheduleForLang } from "@/lib/publication-scheduler";

describe("Studio Ameublo grid", () => {
  it("defaults to 4 Reels a day at fixed hours, every day", () => {
    const s = parseAmeubloSchedule(null);
    expect(s.max_per_day).toBe(4);
    expect(s.slots).toHaveLength(7);
    expect(s.slots[0].times).toEqual(["07:45", "12:15", "18:30", "20:45"]);
    expect(parseAmeubloSchedule("not json").max_per_day).toBe(4);
  });
  it("splits the day: FR gets the 1st and 3rd hour, EN the 2nd and 4th, 2 a day each", () => {
    const s = parseAmeubloSchedule(null);
    const fr = ameubloScheduleForLang(s, "fr");
    const en = ameubloScheduleForLang(s, "en");
    expect(fr.slots[0].times).toEqual(["07:45", "18:30"]);
    expect(en.slots[0].times).toEqual(["12:15", "20:45"]);
    expect(fr.max_per_day).toBe(2);
    expect(en.max_per_day).toBe(2);
  });
  it("a day with a single hour serves both languages", () => {
    const s = parseAmeubloSchedule(JSON.stringify({ enabled: true, timezone: "America/Toronto", max_per_day: 1, slots: [{ day: "mon", times: ["10:00"] }] }));
    expect(ameubloScheduleForLang(s, "fr").slots[0].times).toEqual(["10:00"]);
    expect(ameubloScheduleForLang(s, "en").slots[0].times).toEqual(["10:00"]);
  });
});
