import { describe, it, expect, vi } from "vitest";
import {
  analyzeClip, bestWindow, parseScoreReply, majorityZone, FALLBACK_REASON,
  MIN_SEGMENT, MAX_SEGMENT, type FrameScore,
} from "@/lib/video-scene-selector";

vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: () => ({}) }));
vi.mock("@/lib/llm-budget", () => ({ budgetedCreate: vi.fn() }));

const f = (t: number, score: number, reason = "r", zone: "top" | "middle" | "bottom" = "middle"): FrameScore =>
  ({ t, score, reason, zone });

describe("parseScoreReply", () => {
  it("reads strict JSON", () => {
    expect(parseScoreReply('{"score": 8, "reason": "clean"}')).toEqual({ score: 8, reason: "clean", zone: "middle" });
  });

  // The prompt literally asks for {score: N, reason: 'brief'} — valid JS, invalid JSON. The
  // model obliges, so the parser has to repair it rather than drop every frame.
  it("repairs the bare-key single-quoted shape the prompt itself asks for", () => {
    expect(parseScoreReply("{score: 7, reason: 'product centred'}")).toEqual({
      score: 7, reason: "product centred", zone: "middle",
    });
  });

  it("ignores prose around the object", () => {
    expect(parseScoreReply('Here you go:\n{"score": 5, "reason": "dim"}\nHope that helps')?.score).toBe(5);
  });

  it("clamps out-of-range scores instead of discarding a real ranking", () => {
    expect(parseScoreReply('{"score": 0}')?.score).toBe(1);
    expect(parseScoreReply('{"score": 42}')?.score).toBe(10);
  });

  it("accepts a numeric string score", () => {
    expect(parseScoreReply('{"score": "6", "reason": "ok"}')?.score).toBe(6);
  });

  it("returns null on garbage, a missing score, or no object at all", () => {
    expect(parseScoreReply("no json here")).toBeNull();
    expect(parseScoreReply('{"reason": "forgot the score"}')).toBeNull();
    expect(parseScoreReply("")).toBeNull();
  });
});

describe("bestWindow", () => {
  it("returns the whole clip when it is shorter than the minimum segment", () => {
    const w = bestWindow([f(2, 9), f(6, 8)], 10);
    expect(w.startTime).toBe(0);
    expect(w.endTime).toBe(10);
    expect(w.avgScore).toBe(8.5);
  });

  it("picks the window covering the high-scoring frames", () => {
    // 60 s clip: junk at the head, good footage from ~30 s on.
    const frames = [f(5, 2), f(12, 2), f(20, 3), f(32, 9), f(38, 9), f(44, 10), f(50, 9)];
    const w = bestWindow(frames, 60);
    expect(w.startTime).toBeGreaterThanOrEqual(29);
    expect(w.endTime - w.startTime).toBeCloseTo(MAX_SEGMENT, 3);
    expect(w.avgScore).toBeGreaterThan(8.5);
  });

  it("takes the MAX segment when the clip allows, not the minimum", () => {
    const w = bestWindow([f(5, 7), f(15, 7), f(25, 7)], 40);
    expect(w.endTime - w.startTime).toBeCloseTo(MAX_SEGMENT, 3);
    expect(MAX_SEGMENT).toBeGreaterThan(MIN_SEGMENT);
  });

  it("prefers the EARLIEST of equally good windows — the product should show sooner", () => {
    const flat = [f(2, 8), f(10, 8), f(18, 8), f(26, 8), f(34, 8), f(42, 8)];
    expect(bestWindow(flat, 50).startTime).toBe(0);
  });

  it("never runs past the end of the clip", () => {
    const w = bestWindow([f(28, 10), f(29, 10)], 30);
    expect(w.endTime).toBeLessThanOrEqual(30);
    expect(w.startTime).toBeGreaterThanOrEqual(0);
  });

  // The reason index arithmetic was rejected: frames go missing exactly when the clip is
  // patchy, which is when the window choice matters most.
  it("still chooses sensibly when most frames failed to score", () => {
    const w = bestWindow([f(40, 10)], 60);
    expect(w.startTime).toBeLessThanOrEqual(40);
    expect(w.endTime).toBeGreaterThanOrEqual(40);
    expect(w.avgScore).toBe(10);
  });

  it("falls back, and says so, when nothing scored at all", () => {
    const w = bestWindow([], 60);
    expect(w.reason).toBe(FALLBACK_REASON);
    expect(w.startTime).toBe(0);
    expect(w.avgScore).toBe(0);
  });

  it("carries the top frame's reason so the log explains the pick", () => {
    const w = bestWindow([f(20, 4, "boîte fermée"), f(25, 10, "produit monté, plein jour")], 60);
    expect(w.reason).toBe("produit monté, plein jour");
  });
});

describe("analyzeClip", () => {
  const seams = (scores: (number | null)[]) => ({
    probeDuration: async () => 60,
    extractFrame: async () => {},
    scoreFrame: vi.fn(async () => {
      const s = scores.shift();
      return s === null || s === undefined ? null : { score: s, reason: `s${s}`, zone: "middle" as const };
    }),
  });

  it("samples frameCount frames at interval midpoints, never at 0 or the last frame", async () => {
    const seen: number[] = [];
    await analyzeClip(__filename, {
      frameCount: 4,
      probeDuration: async () => 40,
      extractFrame: async (_s, t) => { seen.push(t); },
      scoreFrame: async () => ({ score: 5, reason: "", zone: "middle" as const }),
    });
    // Midpoints of four 10 s intervals over a 40 s clip.
    expect(seen).toEqual([5, 15, 25, 35]);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeLessThan(40);
  });

  it("drops frames that fail to score and keeps going", async () => {
    const r = await analyzeClip(__filename, { frameCount: 4, ...seams([8, null, 9, null]) });
    expect(r.frames).toHaveLength(2);
    expect(r.frames.map((x) => x.score)).toEqual([8, 9]);
  });

  it("survives an extractFrame that throws on one frame", async () => {
    let n = 0;
    const r = await analyzeClip(__filename, {
      frameCount: 3,
      probeDuration: async () => 60,
      extractFrame: async () => { if (n++ === 1) throw new Error("seek failed"); },
      scoreFrame: async () => ({ score: 7, reason: "ok", zone: "middle" as const }),
    });
    expect(r.frames).toHaveLength(2);
    expect(r.avgScore).toBe(7);
  });

  it("returns a usable window even when every single frame fails", async () => {
    const r = await analyzeClip(__filename, { frameCount: 3, ...seams([null, null, null]) });
    expect(r.frames).toHaveLength(0);
    expect(r.reason).toBe(FALLBACK_REASON);
    expect(r.endTime).toBeGreaterThan(r.startTime);
  });

  it("throws only for a missing file — there is nothing to render then", async () => {
    await expect(analyzeClip("C:/nope/missing-clip.mp4")).rejects.toThrow(/clip missing/);
  });
});
