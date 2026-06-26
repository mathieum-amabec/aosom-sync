/**
 * Pure timing model for the Top-5 countdown composition (Module D).
 *
 * Kept in its OWN module — deliberately free of any `remotion` import — so the
 * Node-side template (`buildCountdown`) and its dry-run tests can compute the
 * countdown duration / segment layout WITHOUT loading the Remotion runtime or a
 * headless browser. The `.tsx` composition imports these same constants so the
 * preview, the real render, and the manifest never disagree.
 *
 * Sequence (frames @ 30 fps), counting DOWN from #5 to #1:
 *   intro (30) → reveal #5 (60) → #4 (60) → #3 (60) → #2 (60) → #1 (90, winner) → outro (30)
 * For the canonical 5 items that is 30 + 60·4 + 90 + 30 = 390 frames (13 s).
 */

/** Frame rate of the countdown composition. */
export const COUNTDOWN_FPS = 30;

/** Output dimensions — 9:16 vertical Reel only. */
export const COUNTDOWN_WIDTH = 1080;
export const COUNTDOWN_HEIGHT = 1920;

/** Intro / outro card lengths (frames). */
export const INTRO_FRAMES = 30;
export const OUTRO_FRAMES = 30;
/** A normal rank reveal; the #1 winner gets a longer beat. */
export const REVEAL_FRAMES = 60;
export const WINNER_FRAMES = 90;

/** One revealed rank: which product, which rank label, and where it sits on the timeline. */
export interface CountdownSegment {
  /** Rank shown on the card — counts DOWN: itemCount … 1. */
  rank: number;
  /** Index into the `items` array (0 = the #1 winner / best seller). */
  itemIndex: number;
  /** First frame of this segment (absolute, from composition start). */
  from: number;
  /** Length of this segment in frames. */
  durationInFrames: number;
}

/** Full timeline: intro, the ranked reveals (5→1), outro, and the total frame count. */
export interface CountdownTiming {
  introFrames: number;
  outroFrames: number;
  segments: CountdownSegment[];
  durationInFrames: number;
}

/**
 * Build the countdown timeline for `itemCount` products.
 *
 * Reveals run 5→1: the first segment shows the LOWEST rank (e.g. #5, the worst
 * of the top set = `items[itemCount-1]`) and the last shows #1 (`items[0]`, the
 * best seller) with the longer winner beat. Generic over itemCount so a Top-3 or
 * Top-10 reuses the same math, though the engine targets exactly 5.
 */
export function computeCountdownTiming(itemCount: number): CountdownTiming {
  const segments: CountdownSegment[] = [];
  let cursor = INTRO_FRAMES;
  for (let k = 0; k < itemCount; k++) {
    const rank = itemCount - k; // reveal itemCount … 1
    const itemIndex = itemCount - 1 - k; // worst-ranked first, winner (#1 = index 0) last
    const durationInFrames = rank === 1 ? WINNER_FRAMES : REVEAL_FRAMES;
    segments.push({ rank, itemIndex, from: cursor, durationInFrames });
    cursor += durationInFrames;
  }
  return {
    introFrames: INTRO_FRAMES,
    outroFrames: OUTRO_FRAMES,
    segments,
    durationInFrames: cursor + OUTRO_FRAMES,
  };
}

/** Total runtime in seconds for `itemCount` products (durationInFrames / fps). */
export function countdownDurationSec(itemCount: number): number {
  return computeCountdownTiming(itemCount).durationInFrames / COUNTDOWN_FPS;
}
