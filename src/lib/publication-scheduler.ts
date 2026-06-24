// Publication auto-scheduler.
//
// Computes the next free posting slot from a user-configured `publication_schedule`
// (per-weekday local times + a per-day cap), skipping slots already occupied by
// scheduled drafts. This generalizes the fixed Mon/Wed/Fri 15:00 UTC grid in
// draft-scheduler.ts into a fully configurable, timezone-aware schedule.
//
// Timestamps are unix SECONDS throughout, matching the `facebook_drafts.scheduled_at`
// column and draft-scheduler.ts. The pure functions take a reference `nowSec` and an
// explicit occupancy list so they're deterministic and unit-testable; the async
// `getNextAvailableSlot` wires them to the live scheduled-draft queue.

import {
  type PublicationSchedule,
  type PublicationSlot,
  type BlogSchedule,
  type WeekdayKey,
  type VideoSchedule,
  type VideoRatio,
  type VideoPlatform,
  WEEKDAY_KEYS,
  VIDEO_RATIOS,
  VIDEO_PLATFORMS,
  DEFAULT_PUBLICATION_SCHEDULE,
  DEFAULT_VIDEO_SCHEDULE,
  DEFAULT_BLOG_SCHEDULE,
} from "@/lib/config";
import { getScheduledDraftSlots } from "@/lib/database";

/** Platforms that post on the shared `publication_schedule`. */
export type PublishPlatform = "facebook" | "instagram";

/** weekday key → JS day index (0=Sun … 6=Sat). */
const WEEKDAY_INDEX: Record<WeekdayKey, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// How far ahead to look for an open slot before giving up. 70 days comfortably
// spans any weekly cadence even when every near slot is full.
const HORIZON_DAYS = 70;

// ─── Validators ─────────────────────────────────────────────────────

export function isWeekdayKey(v: unknown): v is WeekdayKey {
  return typeof v === "string" && (WEEKDAY_KEYS as readonly string[]).includes(v);
}

export function isHHMM(v: unknown): v is string {
  return typeof v === "string" && HHMM_RE.test(v);
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ─── Parsing / normalization ────────────────────────────────────────

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function normalizeSlot(raw: unknown): PublicationSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isWeekdayKey(r.day)) return null;
  const times = Array.isArray(r.times) ? r.times.filter(isHHMM) : [];
  // de-dupe + chronological order so the UI and slot enumeration are stable.
  const unique = Array.from(new Set(times)).sort();
  if (unique.length === 0) return null;
  return { day: r.day, times: unique };
}

/** Coerce arbitrary JSON into a valid PublicationSchedule, falling back per-field to `d`. */
function normalizeScheduleWith(raw: unknown, d: PublicationSchedule): PublicationSchedule {
  if (!raw || typeof raw !== "object") return clone(d);
  const r = raw as Record<string, unknown>;
  const slots = Array.isArray(r.slots)
    ? mergeSlotsByDay(r.slots.map(normalizeSlot).filter((s): s is PublicationSlot => s !== null))
    : clone(d.slots);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    slots,
    timezone: isValidTimeZone(r.timezone) ? r.timezone : d.timezone,
    max_per_day: clampInt(r.max_per_day, 1, 5, d.max_per_day),
  };
}

/** Coerce arbitrary JSON into a valid PublicationSchedule (social defaults). */
export function normalizePublicationSchedule(raw: unknown): PublicationSchedule {
  return normalizeScheduleWith(raw, DEFAULT_PUBLICATION_SCHEDULE);
}

/** Coerce arbitrary JSON into a valid video schedule (base shape + ratio/platform). */
export function normalizeVideoSchedule(raw: unknown): VideoSchedule {
  const base = normalizeScheduleWith(raw, DEFAULT_VIDEO_SCHEDULE);
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ratio = (VIDEO_RATIOS as readonly string[]).includes(r.ratio as string)
    ? (r.ratio as VideoRatio)
    : DEFAULT_VIDEO_SCHEDULE.ratio;
  const platform = (VIDEO_PLATFORMS as readonly string[]).includes(r.platform as string)
    ? (r.platform as VideoPlatform)
    : DEFAULT_VIDEO_SCHEDULE.platform;
  return { ...base, ratio, platform };
}

/** Collapse multiple slots for the same weekday into one, in weekday order. */
function mergeSlotsByDay(slots: PublicationSlot[]): PublicationSlot[] {
  const byDay = new Map<WeekdayKey, Set<string>>();
  for (const s of slots) {
    const set = byDay.get(s.day) ?? new Set<string>();
    for (const t of s.times) set.add(t);
    byDay.set(s.day, set);
  }
  return WEEKDAY_KEYS
    .filter((d) => byDay.has(d))
    .map((d) => ({ day: d, times: Array.from(byDay.get(d)!).sort() }));
}

export function normalizeBlogSchedule(raw: unknown): BlogSchedule {
  const d = DEFAULT_BLOG_SCHEDULE;
  if (!raw || typeof raw !== "object") return clone(d);
  const r = raw as Record<string, unknown>;
  const preferred = Array.isArray(r.preferred_days)
    ? WEEKDAY_KEYS.filter((k) => (r.preferred_days as unknown[]).includes(k))
    : clone(d.preferred_days);
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    posts_per_week: clampInt(r.posts_per_week, 1, 3, d.posts_per_week),
    preferred_days: preferred.length > 0 ? preferred : clone(d.preferred_days),
    preferred_time: isHHMM(r.preferred_time) ? r.preferred_time : d.preferred_time,
  };
}

/** Parse a stored JSON string (or null) into a PublicationSchedule; defaults on any error. */
export function parsePublicationSchedule(rawJson: string | null | undefined): PublicationSchedule {
  if (!rawJson) return clone(DEFAULT_PUBLICATION_SCHEDULE);
  try {
    return normalizePublicationSchedule(JSON.parse(rawJson));
  } catch {
    return clone(DEFAULT_PUBLICATION_SCHEDULE);
  }
}

export function parseBlogSchedule(rawJson: string | null | undefined): BlogSchedule {
  if (!rawJson) return clone(DEFAULT_BLOG_SCHEDULE);
  try {
    return normalizeBlogSchedule(JSON.parse(rawJson));
  } catch {
    return clone(DEFAULT_BLOG_SCHEDULE);
  }
}

/** Parse the stored video_schedule JSON (or null) into a VideoSchedule; video defaults on error. */
export function parseVideoSchedule(rawJson: string | null | undefined): VideoSchedule {
  if (!rawJson) return clone(DEFAULT_VIDEO_SCHEDULE);
  try {
    return normalizeVideoSchedule(JSON.parse(rawJson));
  } catch {
    return clone(DEFAULT_VIDEO_SCHEDULE);
  }
}

// ─── Timezone helpers ───────────────────────────────────────────────

/**
 * Offset in ms between `timeZone`'s wall clock and UTC at the given instant:
 * localWallClock = utc + offset. Negative for west-of-UTC zones (e.g. -5h/-4h
 * for America/Toronto depending on DST).
 */
function tzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some engines render midnight as "24"
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return asIfUtc - date.getTime();
}

/**
 * Convert a wall-clock date+time in `timeZone` to a unix-seconds UTC timestamp.
 * Resolves the offset twice so instants near a DST transition land correctly.
 */
function zonedWallTimeToUnixSec(
  y: number, mo0: number, d: number, h: number, mi: number, timeZone: string,
): number {
  const naiveUtc = Date.UTC(y, mo0, d, h, mi, 0);
  const o1 = tzOffsetMs(timeZone, new Date(naiveUtc));
  const o2 = tzOffsetMs(timeZone, new Date(naiveUtc - o1));
  return Math.floor((naiveUtc - o2) / 1000);
}

/** The local calendar date (year, 0-based month, day) of an instant in `timeZone`. */
function tzCalendarDate(timeZone: string, atSec: number): { y: number; mo0: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(atSec * 1000))) parts[p.type] = p.value;
  return { y: Number(parts.year), mo0: Number(parts.month) - 1, d: Number(parts.day) };
}

/** Stable "YYYY-MM-DD" key for a slot's local calendar day — used for max_per_day. */
function localDayKey(timeZone: string, atSec: number): string {
  const { y, mo0, d } = tzCalendarDate(timeZone, atSec);
  return `${y}-${String(mo0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Weekday key of a calendar date (timezone-independent — a date has one weekday). */
function weekdayKeyOf(y: number, mo0: number, d: number): WeekdayKey {
  const idx = new Date(Date.UTC(y, mo0, d)).getUTCDay();
  return WEEKDAY_KEYS.find((k) => WEEKDAY_INDEX[k] === idx)!;
}

// ─── Slot enumeration ───────────────────────────────────────────────

/**
 * All configured slot timestamps (unix seconds) strictly after `nowSec`, in
 * ascending order, looking up to `horizonDays` ahead. Returns [] when the
 * schedule is disabled or has no valid times.
 */
export function enumerateSlots(
  schedule: PublicationSchedule,
  nowSec: number,
  horizonDays: number = HORIZON_DAYS,
): number[] {
  if (!schedule.enabled) return [];
  const tz = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";

  const timesByDay = new Map<WeekdayKey, string[]>();
  for (const slot of schedule.slots) {
    if (!isWeekdayKey(slot.day)) continue;
    const valid = (slot.times || []).filter(isHHMM);
    if (valid.length) timesByDay.set(slot.day, valid);
  }
  if (timesByDay.size === 0) return [];

  const start = tzCalendarDate(tz, nowSec);
  const out: number[] = [];
  for (let i = 0; i < horizonDays; i++) {
    // Add `i` days in calendar terms; Date.UTC normalizes month/year rollover.
    const dd = new Date(Date.UTC(start.y, start.mo0, start.d + i));
    const y = dd.getUTCFullYear();
    const mo0 = dd.getUTCMonth();
    const d = dd.getUTCDate();
    const times = timesByDay.get(weekdayKeyOf(y, mo0, d));
    if (!times) continue;
    for (const t of times) {
      const [h, mi] = t.split(":").map(Number);
      const sec = zonedWallTimeToUnixSec(y, mo0, d, h, mi, tz);
      if (sec > nowSec) out.push(sec);
    }
  }
  return out.sort((a, b) => a - b);
}

// ─── Next available slot ────────────────────────────────────────────

export interface NextSlot {
  /** Platform the slot was computed for (echoes the caller's argument). */
  platform: PublishPlatform;
  /** Slot start, unix seconds (UTC). Directly usable as `facebook_drafts.scheduled_at`. */
  at: number;
  /** Same instant as an ISO-8601 UTC string, for display/logging. */
  iso: string;
  /**
   * Same instant as SQLite `datetime()` text — `'YYYY-MM-DD HH:MM:SS'` (UTC).
   * This is the exact shape `publication_queue.scheduled_at` requires (and that
   * `addToQueue`/`isSqliteUtc` validate), so the queue path can use it directly
   * without importing the unix→SQLite converter from `draft-scheduler`.
   */
  sqlite: string;
}

/**
 * Find the next free publication slot for `platform`.
 *
 * Reads `publication_schedule` from `settings`, then walks the configured slots
 * forward from now and returns the first that is (a) not already occupied by a
 * scheduled draft and (b) on a day that hasn't reached `max_per_day`. Returns
 * null when scheduling is disabled or no slot opens within the horizon.
 *
 * The publication queue (`facebook_drafts`) is shared across platforms, so
 * occupancy is computed from all scheduled drafts; `platform` is carried through
 * for the caller and reserved for future per-platform queues. Pass `opts.nowSec`
 * / `opts.occupied` to drive the function deterministically in tests.
 */
export async function getNextAvailableSlot(
  platform: PublishPlatform,
  settings: Record<string, string>,
  opts: { nowSec?: number; occupied?: number[]; schedule?: PublicationSchedule } = {},
): Promise<NextSlot | null> {
  // `opts.schedule` lets callers slot against a non-default schedule (e.g. video_schedule)
  // while keeping the same occupancy + max_per_day logic. Defaults to publication_schedule.
  const schedule = opts.schedule ?? parsePublicationSchedule(settings.publication_schedule);
  if (!schedule.enabled) return null;

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const occupied =
    opts.occupied ??
    (await getScheduledDraftSlots())
      .map((s) => s.scheduledAt)
      .filter((n): n is number => n != null);

  const occupiedSet = new Set(occupied);
  const perDayCount = new Map<string, number>();
  for (const ts of occupied) {
    const key = localDayKey(schedule.timezone, ts);
    perDayCount.set(key, (perDayCount.get(key) ?? 0) + 1);
  }

  for (const slot of enumerateSlots(schedule, nowSec)) {
    if (occupiedSet.has(slot)) continue;
    const dayKey = localDayKey(schedule.timezone, slot);
    if ((perDayCount.get(dayKey) ?? 0) >= schedule.max_per_day) continue;
    const iso = new Date(slot * 1000).toISOString();
    return { platform, at: slot, iso, sqlite: iso.slice(0, 19).replace("T", " ") };
  }
  return null;
}
