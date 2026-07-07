import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { pickMusicTrack, listAllMusicTracks } from "@/lib/slideshow/music";

// The royalty-free tracks live under gitignored src/audio (not committed), so these
// tests mock fs.readdirSync to stay deterministic and repo-independent.
describe("music track selection (quality v3 rotation)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("empty audio roots → [] and a null (silent) pick", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue([] as unknown as fs.Dirent[]);
    expect(listAllMusicTracks()).toEqual([]);
    expect(pickMusicTrack()).toBeNull();
  });

  it("keeps only audio files, as absolute paths under both roots", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["a.mp3", "readme.txt", "b.wav"] as unknown as fs.Dirent[]);
    const all = listAllMusicTracks(); // src/audio + public/music, each returns the mock
    expect(all.length).toBe(4); // 2 audio files × 2 roots (readme.txt filtered out)
    expect(all.every((p) => /\.(mp3|m4a|aac|wav|ogg)$/i.test(p))).toBe(true);
    expect(all.every((p) => /[\\/]/.test(p))).toBe(true);
  });

  it("pickMusicTrack rotates by the Math.random index", () => {
    vi.spyOn(fs, "readdirSync").mockReturnValue(["a.mp3", "b.mp3"] as unknown as fs.Dirent[]);
    const all = listAllMusicTracks();
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pickMusicTrack()).toBe(all[0]);
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(pickMusicTrack()).toBe(all[all.length - 1]);
  });
});
