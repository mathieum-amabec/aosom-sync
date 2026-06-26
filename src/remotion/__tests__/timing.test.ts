import { describe, it, expect } from "vitest";
import {
  computeCountdownTiming,
  countdownDurationSec,
  COUNTDOWN_FPS,
  INTRO_FRAMES,
  OUTRO_FRAMES,
  REVEAL_FRAMES,
  WINNER_FRAMES,
} from "@/remotion/timing";

describe("computeCountdownTiming", () => {
  it("lays out a 5-item countdown as 390 frames (13s @ 30fps)", () => {
    const t = computeCountdownTiming(5);
    expect(t.durationInFrames).toBe(INTRO_FRAMES + REVEAL_FRAMES * 4 + WINNER_FRAMES + OUTRO_FRAMES);
    expect(t.durationInFrames).toBe(390);
    expect(countdownDurationSec(5)).toBe(13);
    expect(COUNTDOWN_FPS).toBe(30);
  });

  it("reveals ranks 5→1, mapping the winner (#1) to items[0] with the longer beat", () => {
    const t = computeCountdownTiming(5);
    expect(t.segments).toHaveLength(5);
    // First reveal = lowest rank, last product; last reveal = #1, first product.
    expect(t.segments[0]).toMatchObject({ rank: 5, itemIndex: 4, from: 30, durationInFrames: 60 });
    expect(t.segments[4]).toMatchObject({ rank: 1, itemIndex: 0, durationInFrames: 90 });
    // Segments are contiguous, starting right after the intro.
    expect(t.segments[0].from).toBe(INTRO_FRAMES);
    for (let i = 1; i < t.segments.length; i++) {
      expect(t.segments[i].from).toBe(t.segments[i - 1].from + t.segments[i - 1].durationInFrames);
    }
    // The outro fills exactly the tail.
    const lastSeg = t.segments[t.segments.length - 1];
    expect(t.durationInFrames - (lastSeg.from + lastSeg.durationInFrames)).toBe(OUTRO_FRAMES);
  });

  it("only the #1 winner gets the longer beat", () => {
    const t = computeCountdownTiming(5);
    const winners = t.segments.filter((s) => s.durationInFrames === WINNER_FRAMES);
    expect(winners).toHaveLength(1);
    expect(winners[0].rank).toBe(1);
  });
});
