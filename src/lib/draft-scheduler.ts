// Auto-scheduling slot math for approved content_template drafts.
//
// Posting cadence: Mon / Wed / Fri at 10:00 EST. The task fixes this at 15:00 UTC
// (a fixed -5 offset, NOT DST-adjusted — so it lands 10:00 in winter / 11:00 in
// summer local; deterministic and matches the spec's "10h00 EST (= 15h00 UTC)").
//
// Per-slot capacity: at most 1 FR post + 1 EN post. content_template drafts are
// bilingual (post_text = FR, post_text_en = EN), so a bilingual draft fills both
// the FR and EN capacity of a slot on its own; an FR-only and an EN-only draft can
// share one slot. These functions are pure (no DB / no `Date.now()` dependency —
// the caller passes the reference time) so they're fully unit-testable.

export const POSTING_WEEKDAYS_UTC = [1, 3, 5]; // Mon, Wed, Fri (UTC weekday at the slot instant)
export const SLOT_HOUR_UTC = 15; // 10:00 EST
export const MAX_PER_LANG_PER_SLOT = 1;
const DAY_SEC = 86_400;
const HORIZON_SLOTS = 366; // safety cap (~2.8 years of M/W/F) so findSlot never loops forever

export interface DraftLangs {
  fr: boolean; // has FR text (post_text)
  en: boolean; // has EN text (post_text_en)
}

export interface SlotOccupancy {
  fr: number; // FR posts already scheduled at this slot
  en: number; // EN posts already scheduled at this slot
}

/** Does this draft post in at least one language? */
export function langsOf(postText?: string | null, postTextEn?: string | null): DraftLangs {
  return { fr: !!postText && postText.trim() !== "", en: !!postTextEn && postTextEn.trim() !== "" };
}

/**
 * The next `count` posting-slot timestamps (unix seconds) strictly after `afterSec`.
 * Each is 15:00:00 UTC on a Mon/Wed/Fri.
 */
export function upcomingSlots(afterSec: number, count: number): number[] {
  const slots: number[] = [];
  const d = new Date(afterSec * 1000);
  d.setUTCHours(SLOT_HOUR_UTC, 0, 0, 0); // 15:00:00.000 UTC on afterSec's day
  let cursor = Math.floor(d.getTime() / 1000);
  // UTC has no DST, so stepping +86400 keeps the wall-clock at 15:00 UTC.
  let guard = 0;
  while (slots.length < count && guard++ < count + 14) {
    if (cursor > afterSec && POSTING_WEEKDAYS_UTC.includes(new Date(cursor * 1000).getUTCDay())) {
      slots.push(cursor);
    }
    cursor += DAY_SEC;
  }
  return slots;
}

/**
 * Find the first posting slot at/after `afterSec` that has room for a draft posting
 * in `langs`. A slot has room when adding the draft keeps each language's count
 * <= MAX_PER_LANG_PER_SLOT. `occupancyBySlot` maps a slot timestamp → its current
 * FR/EN counts (slots not present are empty).
 * Returns the slot timestamp (unix seconds), or null if none within the horizon.
 */
export function findSlot(
  afterSec: number,
  langs: DraftLangs,
  occupancyBySlot: Map<number, SlotOccupancy>,
  maxPerLang: number = MAX_PER_LANG_PER_SLOT,
): number | null {
  if (!langs.fr && !langs.en) return null; // nothing to post
  for (const slot of upcomingSlots(afterSec, HORIZON_SLOTS)) {
    const occ = occupancyBySlot.get(slot) ?? { fr: 0, en: 0 };
    const frOk = !langs.fr || occ.fr < maxPerLang;
    const enOk = !langs.en || occ.en < maxPerLang;
    if (frOk && enOk) return slot;
  }
  return null;
}

/**
 * Build a slot → occupancy map from already-scheduled drafts, keyed by raw
 * scheduled_at. Off-grid manual schedules (timestamps not on the M/W/F 15:00 UTC grid)
 * are stored but never read: findSlot only ever looks up on-grid slots, so off-grid
 * drafts neither block an auto-slot nor get double-booked.
 */
export function buildOccupancy(
  scheduled: Array<{ scheduledAt: number | null; fr: boolean; en: boolean }>,
): Map<number, SlotOccupancy> {
  const map = new Map<number, SlotOccupancy>();
  for (const s of scheduled) {
    if (s.scheduledAt == null) continue;
    const occ = map.get(s.scheduledAt) ?? { fr: 0, en: 0 };
    if (s.fr) occ.fr += 1;
    if (s.en) occ.en += 1;
    map.set(s.scheduledAt, occ);
  }
  return map;
}
