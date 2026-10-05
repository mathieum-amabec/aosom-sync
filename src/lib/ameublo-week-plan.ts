/**
 * "Plan de la semaine" — proposes which approved-to-be Studio video goes on which slot for the
 * next days, so the operator approves a whole week in one click instead of one video at a time.
 *
 * Pure: no DB, no clock. The caller passes the candidates (Studio videos nobody approved yet), the
 * slots already taken, and `now`. Nothing here approves anything — `approveAmeubloVideoAt` does,
 * and only when the operator confirms the proposed plan.
 *
 * The grid (America/Toronto), one video per page per slot — FR = Ameublo Direct, EN = Furnish
 * Direct, EN 5 minutes later because `publication_queue` forbids two rows on the same minute:
 *   S0 06:00 / 06:05  seasonal-exclusive (only while a seasonal campaign is on, and only seasonal videos)
 *   S1 07:45 / 07:50  educational rail
 *   S2 12:15 / 12:20  products rail
 *   S3 19:45 / 19:50  entertainment rail
 */
import { enumerateSlots } from "@/lib/publication-scheduler";
import type { PublicationSchedule, WeekdayKey } from "@/lib/config";

export type PlanLang = "fr" | "en";
export type SlotKey = "S0" | "S1" | "S2" | "S3";

export const WEEK_TIMEZONE = "America/Toronto";
export const WEEK_SLOTS: { key: SlotKey; fr: string; en: string; label: string }[] = [
  { key: "S0", fr: "06:00", en: "06:05", label: "Saisonnier" },
  { key: "S1", fr: "07:45", en: "07:50", label: "Éducatif" },
  { key: "S2", fr: "12:15", en: "12:20", label: "Produits" },
  { key: "S3", fr: "19:45", en: "19:50", label: "Divertissement" },
];

/** Seasonal campaign window: while it is on, the 06:00 slot is reserved for its videos. */
export const SEASONAL = { match: /^halloween/i, until: "2026-11-01T04:00:00Z" /* 2026-11-01 00:00 Toronto */ };
export const isSeasonalActive = (nowSec: number): boolean => nowSec * 1000 < Date.parse(SEASONAL.until);

const WEEKDAYS: WeekdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** Preferred styles per rail and weekday; anything missing falls back to "any remaining video". */
export const RAIL_STYLES: { S1: Record<WeekdayKey, string[]>; S2: Record<WeekdayKey, string[]>; S3: Record<WeekdayKey, string[]> } = {
  S1: Object.fromEntries(WEEKDAYS.map((d) => [d, ["mesure", "astuce", "piece", "devine"]])) as Record<WeekdayKey, string[]>,
  S2: {
    mon: ["vitrine", "top3", "piece"], tue: ["budget", "top3", "vitrine"], wed: ["top3", "vitrine", "piece"], thu: ["vitrine", "top3", "piece"],
    fri: ["top3", "vitrine", "piece"], sat: ["piece", "vitrine", "top3"], sun: ["vitrine", "top3", "piece"],
  },
  S3: {
    mon: ["vote", "ab"], tue: ["aventure", "reaction"], wed: ["vote", "ab"], thu: ["aventure", "reaction"],
    fri: ["reaction"], sat: ["devine"], sun: ["reaction"],
  },
};

export interface PlanCandidate {
  id: number;
  lang: PlanLang;
  style: string;
  campaign: string | null;
  series: string;
  label: string | null;
}
export interface PlanEntry {
  id: number;
  lang: PlanLang;
  slot: SlotKey;
  /** SQLite UTC text, the shape `publication_queue.scheduled_at` requires. */
  at: string;
  /** Toronto calendar day, YYYY-MM-DD. */
  day: string;
  seasonal: boolean;
}

const sqliteOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
const dayOf = (sec: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: WEEK_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(sec * 1000));
const weekdayOf = (sec: number): WeekdayKey => {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: WEEK_TIMEZONE, weekday: "short" }).format(new Date(sec * 1000)).toLowerCase().slice(0, 3);
  return wd as WeekdayKey;
};

export const isSeasonalVideo = (v: Pick<PlanCandidate, "campaign" | "series" | "label">): boolean =>
  SEASONAL.match.test(v.campaign ?? "") || /halloween/i.test(`${v.series} ${v.label ?? ""}`);

/** Every slot of one rail for one language in the next `days` days, as unix seconds. */
function railSlots(key: SlotKey, lang: PlanLang, nowSec: number, days: number): number[] {
  const t = WEEK_SLOTS.find((s) => s.key === key)![lang];
  const schedule: PublicationSchedule = {
    enabled: true,
    slots: WEEKDAYS.map((day) => ({ day, times: [t] })),
    timezone: WEEK_TIMEZONE,
    max_per_day: 1,
  };
  return enumerateSlots(schedule, nowSec, days);
}

/**
 * Fill the free slots of the next `days` days, FR and EN independently, oldest videos first.
 * Seasonal videos go first: the S0 slot only takes them, and the other rails take them ahead of
 * regular ones (the S1 educational rail keeps regular videos while any exist, for variety).
 */
export function planWeek(opts: {
  candidates: PlanCandidate[];
  /** `scheduled_at` (SQLite UTC) of every queue row already holding a slot on platform 'both'. */
  occupied: Iterable<string>;
  nowSec: number;
  days?: number;
}): PlanEntry[] {
  const days = opts.days ?? 7;
  const taken = new Set(opts.occupied);
  const seasonalOn = isSeasonalActive(opts.nowSec);
  const out: PlanEntry[] = [];

  for (const lang of ["fr", "en"] as const) {
    const pool = opts.candidates.filter((c) => c.lang === lang).sort((a, b) => a.id - b.id);
    const take = (pred: (c: PlanCandidate) => boolean): PlanCandidate | undefined => {
      const i = pool.findIndex(pred);
      return i >= 0 ? pool.splice(i, 1)[0] : undefined;
    };
    const byStyles = (styles: string[], seasonal: boolean | null) => {
      for (const s of styles) {
        const c = take((x) => x.style === s && (seasonal === null || isSeasonalVideo(x) === seasonal));
        if (c) return c;
      }
      return take((x) => seasonal === null || isSeasonalVideo(x) === seasonal);
    };

    const slots = (["S0", "S1", "S2", "S3"] as const)
      .flatMap((key) => railSlots(key, lang, opts.nowSec, days).map((at) => ({ key, at })))
      .sort((a, b) => a.at - b.at);

    for (const { key, at } of slots) {
      if (!pool.length) break;
      const sqlite = sqliteOf(at);
      if (taken.has(sqlite)) continue;
      if (key === "S0" && !seasonalOn) continue;
      const wd = weekdayOf(at);
      let pick: PlanCandidate | undefined;
      if (key === "S0") pick = take(isSeasonalVideo);
      else if (key === "S1") pick = byStyles(RAIL_STYLES.S1[wd], false) ?? byStyles(RAIL_STYLES.S1[wd], null);
      else pick = byStyles(RAIL_STYLES[key][wd], true) ?? byStyles(RAIL_STYLES[key][wd], null);
      if (!pick) continue;
      out.push({ id: pick.id, lang, slot: key, at: sqlite, day: dayOf(at), seasonal: isSeasonalVideo(pick) });
    }
  }
  return out.sort((a, b) => (a.at === b.at ? a.lang.localeCompare(b.lang) : a.at < b.at ? -1 : 1));
}

/** True when `at` is one of the grid's slots for `lang` within the horizon (so the API never books an arbitrary time). */
export function isGridSlot(lang: PlanLang, at: string, nowSec: number, days = 14): boolean {
  return (["S0", "S1", "S2", "S3"] as const).some(
    (key) => (key !== "S0" || isSeasonalActive(nowSec)) && railSlots(key, lang, nowSec, days).some((s) => sqliteOf(s) === at),
  );
}
