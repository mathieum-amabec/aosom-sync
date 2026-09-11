import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { pickMusicTrack, listAllMusicTracks, getDefaultMusicTrack } from "@/lib/slideshow/music";

// The royalty-free tracks live under gitignored src/audio (not committed), so these
// tests mock fs.readdirSync to stay deterministic and repo-independent.
describe("music track selection (quality v3 rotation)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("empty audio roots → [] and a null (silent) pick", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    expect(listAllMusicTracks()).toEqual([]);
    expect(pickMusicTrack()).toBeNull();
  });

  it("keeps only audio files, as absolute paths under both roots", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["a.mp3", "readme.txt", "b.wav"] as unknown as ReturnType<typeof fs.readdirSync>);
    const all = listAllMusicTracks(); // src/audio + public/music, each returns the mock
    expect(all.length).toBe(4); // 2 audio files × 2 roots (readme.txt filtered out)
    expect(all.every((p) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(p))).toBe(true);
    expect(all.every((p) => /[\\/]/.test(p))).toBe(true);
  });

  it("pickMusicTrack rotates by the Math.random index", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["a.mp3", "b.mp3"] as unknown as ReturnType<typeof fs.readdirSync>);
    const all = listAllMusicTracks();
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickMusicTrack()).toBe(all[0]);
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(pickMusicTrack()).toBe(all[all.length - 1]);
  });

  // The slideshow picker enumerates the same gitignored src/audio as the ad composer, so a
  // bed retired from the ad families would otherwise keep turning up on slideshow renders.
  describe("retired beds", () => {
    const RETIRED = "mixkit-corporate-22.mp3";

    it("listAllMusicTracks drops it, so pickMusicTrack can never draw it", () => {
      vi.spyOn(fs, "readdirSync").mockReturnValue(
        [RETIRED, "keep.mp3"] as unknown as ReturnType<typeof fs.readdirSync>,
      );
      const all = listAllMusicTracks();
      expect(all.some((t) => t.includes(RETIRED))).toBe(false);
      expect(all.length).toBe(2); // keep.mp3 under each of the two roots
      for (const r of [0, 0.5, 0.999999]) {
        vi.spyOn(Math, "random").mockReturnValue(r);
        expect(pickMusicTrack()).not.toContain(RETIRED);
      }
    });

    it("goes silent rather than falling back to a retired bed", () => {
      vi.spyOn(fs, "readdirSync").mockReturnValue([RETIRED] as unknown as ReturnType<typeof fs.readdirSync>);
      expect(listAllMusicTracks()).toEqual([]);
      expect(pickMusicTrack()).toBeNull();
    });

    it("is never the positional default either", () => {
      // "mixkit-corporate-22" sorts before "zz" — without the filter it would win by position.
      vi.spyOn(fs, "existsSync").mockReturnValue(false); // no PREFERRED_TRACK on disk
      vi.spyOn(fs, "readdirSync").mockReturnValue(
        [RETIRED, "zz.mp3"] as unknown as ReturnType<typeof fs.readdirSync>,
      );
      expect(getDefaultMusicTrack()).toContain("zz.mp3");
    });
  });
});
