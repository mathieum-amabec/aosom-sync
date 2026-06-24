import { describe, it, expect } from "vitest";
import {
  parsePublicationSchedule,
  parseBlogSchedule,
  parseVideoSchedule,
  normalizePublicationSchedule,
  normalizeBlogSchedule,
  normalizeVideoSchedule,
  enumerateSlots,
  getNextAvailableSlot,
  isHHMM,
  isWeekdayKey,
  isValidTimeZone,
} from "@/lib/publication-scheduler";
import {
  DEFAULT_PUBLICATION_SCHEDULE,
  DEFAULT_VIDEO_SCHEDULE,
  DEFAULT_BLOG_SCHEDULE,
  type PublicationSchedule,
} from "@/lib/config";

const sec = (y: number, m: number, d: number, h = 0, min = 0) =>
  Math.floor(Date.UTC(y, m, d, h, min, 0) / 1000);

// Render a slot back to its local wall clock so tz math is asserted without
// hardcoding DST offsets.
function local(slotSec: number, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, weekday: "short",
    hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(slotSec * 1000))) p[part.type] = part.value;
  return { weekday: p.weekday, time: `${p.hour}:${p.minute}` };
}

// 2026-06-15 00:00 UTC. June → Toronto is on EDT (UTC-4).
const NOW = sec(2026, 5, 15, 0, 0);
const TZ = "America/Toronto";

describe("validators", () => {
  it("isHHMM accepts 24h HH:MM and rejects junk", () => {
    expect(isHHMM("09:00")).toBe(true);
    expect(isHHMM("23:59")).toBe(true);
    expect(isHHMM("24:00")).toBe(false);
    expect(isHHMM("9:00")).toBe(false);
    expect(isHHMM("12:60")).toBe(false);
    expect(isHHMM(900)).toBe(false);
  });

  it("isWeekdayKey + isValidTimeZone", () => {
    expect(isWeekdayKey("mon")).toBe(true);
    expect(isWeekdayKey("monday")).toBe(false);
    expect(isValidTimeZone("America/Toronto")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("parse / normalize", () => {
  it("returns defaults for null / invalid JSON", () => {
    expect(parsePublicationSchedule(null)).toEqual(DEFAULT_PUBLICATION_SCHEDULE);
    expect(parsePublicationSchedule("not json")).toEqual(DEFAULT_PUBLICATION_SCHEDULE);
    expect(parseBlogSchedule(undefined)).toEqual(DEFAULT_BLOG_SCHEDULE);
  });

  it("round-trips the stored default", () => {
    const stored = JSON.stringify(DEFAULT_PUBLICATION_SCHEDULE);
    expect(parsePublicationSchedule(stored)).toEqual(DEFAULT_PUBLICATION_SCHEDULE);
  });

  it("clamps max_per_day to 1..5 and posts_per_week to 1..3", () => {
    expect(normalizePublicationSchedule({ max_per_day: 99 }).max_per_day).toBe(5);
    expect(normalizePublicationSchedule({ max_per_day: 0 }).max_per_day).toBe(1);
    expect(normalizeBlogSchedule({ posts_per_week: 9 }).posts_per_week).toBe(3);
  });

  it("drops invalid days/times, dedupes, and sorts times", () => {
    const n = normalizePublicationSchedule({
      enabled: true,
      timezone: "America/Toronto",
      max_per_day: 2,
      slots: [
        { day: "mon", times: ["18:00", "09:00", "09:00", "bad", "25:00"] },
        { day: "notaday", times: ["10:00"] },
        { day: "wed", times: [] },
      ],
    });
    expect(n.slots).toEqual([{ day: "mon", times: ["09:00", "18:00"] }]);
  });

  it("falls back to a valid timezone when given garbage", () => {
    expect(normalizePublicationSchedule({ timezone: "Nope/Nowhere" }).timezone).toBe(
      DEFAULT_PUBLICATION_SCHEDULE.timezone,
    );
  });

  it("blog preferred_days keeps only valid keys in weekday order", () => {
    const n = normalizeBlogSchedule({ preferred_days: ["fri", "junk", "mon"] });
    expect(n.preferred_days).toEqual(["mon", "fri"]);
  });
});

describe("enumerateSlots", () => {
  const schedule: PublicationSchedule = {
    enabled: true,
    timezone: TZ,
    max_per_day: 3,
    slots: [
      { day: "mon", times: ["09:00", "18:00"] },
      { day: "wed", times: ["09:00"] },
    ],
  };

  it("returns [] when disabled", () => {
    expect(enumerateSlots({ ...schedule, enabled: false }, NOW)).toEqual([]);
  });

  it("returns [] when no day has valid times", () => {
    expect(enumerateSlots({ ...schedule, slots: [] }, NOW)).toEqual([]);
  });

  it("emits only configured local weekdays/times, strictly after now, ascending", () => {
    const slots = enumerateSlots(schedule, NOW, 21);
    expect(slots.length).toBeGreaterThan(0);
    for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThan(slots[i - 1]);
    for (const s of slots) {
      expect(s).toBeGreaterThan(NOW);
      const { weekday, time } = local(s, TZ);
      if (weekday === "Mon") expect(["09:00", "18:00"]).toContain(time);
      else if (weekday === "Wed") expect(time).toBe("09:00");
      else throw new Error(`unexpected weekday ${weekday}`);
    }
  });

  it("resolves DST: a winter (EST) slot is still 09:00 local", () => {
    // January → Toronto is EST (UTC-5).
    const winterNow = sec(2026, 0, 1);
    const winter: PublicationSchedule = { ...schedule, slots: [{ day: "mon", times: ["09:00"] }] };
    const first = enumerateSlots(winter, winterNow, 14)[0];
    expect(local(first, TZ)).toEqual({ weekday: "Mon", time: "09:00" });
  });
});

describe("getNextAvailableSlot", () => {
  const settings = {
    publication_schedule: JSON.stringify({
      enabled: true,
      timezone: TZ,
      max_per_day: 3,
      slots: [{ day: "mon", times: ["09:00", "12:00", "18:00"] }],
    }),
  };

  it("returns null when scheduling is disabled", async () => {
    const off = { publication_schedule: JSON.stringify({ ...DEFAULT_PUBLICATION_SCHEDULE, enabled: false }) };
    expect(await getNextAvailableSlot("facebook", off, { nowSec: NOW, occupied: [] })).toBeNull();
  });

  it("returns the first configured slot when the queue is empty", async () => {
    const next = await getNextAvailableSlot("facebook", settings, { nowSec: NOW, occupied: [] });
    expect(next).not.toBeNull();
    expect(next!.platform).toBe("facebook");
    expect(next!.at).toBeGreaterThan(NOW);
    expect(local(next!.at, TZ)).toEqual({ weekday: "Mon", time: "09:00" });
    expect(next!.iso).toBe(new Date(next!.at * 1000).toISOString());
  });

  it("exposes a SQLite-datetime `sqlite` field matching the queue's required shape", async () => {
    const next = await getNextAvailableSlot("facebook", settings, { nowSec: NOW, occupied: [] });
    // 'YYYY-MM-DD HH:MM:SS' (space, no T/Z) — what publication_queue.scheduled_at requires.
    expect(next!.sqlite).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(next!.sqlite).toBe(next!.iso.slice(0, 19).replace("T", " "));
  });

  it("skips a slot already occupied in the queue", async () => {
    const first = (await getNextAvailableSlot("facebook", settings, { nowSec: NOW, occupied: [] }))!.at;
    const next = await getNextAvailableSlot("facebook", settings, { nowSec: NOW, occupied: [first] });
    expect(next!.at).toBeGreaterThan(first);
    expect(local(next!.at, TZ)).toEqual({ weekday: "Mon", time: "12:00" });
  });

  it("respects max_per_day across the local day", async () => {
    const capped = {
      publication_schedule: JSON.stringify({
        enabled: true,
        timezone: TZ,
        max_per_day: 2,
        slots: [{ day: "mon", times: ["09:00", "12:00", "18:00"] }],
      }),
    };
    // Occupy the first two Monday slots → that Monday is full (2/2).
    const s0 = enumerateSlots(JSON.parse(capped.publication_schedule), NOW)[0];
    const s1 = enumerateSlots(JSON.parse(capped.publication_schedule), NOW)[1];
    const next = await getNextAvailableSlot("facebook", capped, { nowSec: NOW, occupied: [s0, s1] });
    // Not the 3rd slot of the same Monday — must roll to the next week.
    expect(next!.at).toBeGreaterThan(enumerateSlots(JSON.parse(capped.publication_schedule), NOW)[2]);
    expect(local(next!.at, TZ).weekday).toBe("Mon");
  });
});

describe("video schedule", () => {
  it("parse/normalize fall back to the VIDEO default (not the social one)", () => {
    expect(parseVideoSchedule(null)).toEqual(DEFAULT_VIDEO_SCHEDULE);
    expect(parseVideoSchedule("not json")).toEqual(DEFAULT_VIDEO_SCHEDULE);
    expect(normalizeVideoSchedule(undefined)).toEqual(DEFAULT_VIDEO_SCHEDULE);
    // The video default is distinct from the social default (lighter cadence).
    expect(DEFAULT_VIDEO_SCHEDULE.max_per_day).toBe(2);
    expect(DEFAULT_VIDEO_SCHEDULE).not.toEqual(DEFAULT_PUBLICATION_SCHEDULE);
  });

  it("round-trips a stored video schedule and clamps per-field", () => {
    const stored = JSON.stringify({ enabled: false, timezone: "UTC", max_per_day: 99, slots: [{ day: "wed", times: ["10:00", "bad"] }] });
    const out = parseVideoSchedule(stored);
    expect(out.enabled).toBe(false);
    expect(out.timezone).toBe("UTC");
    expect(out.max_per_day).toBe(5); // clamped to 1..5
    expect(out.slots).toEqual([{ day: "wed", times: ["10:00"] }]); // invalid time dropped
  });

  it("getNextAvailableSlot honours an explicit `schedule` override (video) over settings", async () => {
    const videoSchedule = normalizeVideoSchedule({
      enabled: true, timezone: TZ, max_per_day: 2,
      slots: [{ day: "wed", times: ["10:00"] }],
    });
    // settings.publication_schedule is deliberately a DIFFERENT day/time — the override must win.
    const settings = { publication_schedule: JSON.stringify({ enabled: true, timezone: TZ, max_per_day: 3, slots: [{ day: "mon", times: ["09:00"] }] }) };
    const next = await getNextAvailableSlot("facebook", settings, { nowSec: NOW, occupied: [], schedule: videoSchedule });
    expect(next).not.toBeNull();
    expect(local(next!.at, TZ)).toEqual({ weekday: "Wed", time: "10:00" });
  });

  it("getNextAvailableSlot returns null when the video schedule is disabled", async () => {
    const disabled = normalizeVideoSchedule({ ...DEFAULT_VIDEO_SCHEDULE, enabled: false });
    expect(await getNextAvailableSlot("facebook", {}, { nowSec: NOW, occupied: [], schedule: disabled })).toBeNull();
  });
});
