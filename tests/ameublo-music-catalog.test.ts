import { describe, it, expect } from "vitest";
import { MUSIC_CANDIDATES, MUSIC_GROUPS, parsePicks } from "@/lib/ameublo-music-catalog";

describe("ameublo music catalog", () => {
  it("lists 54 numbered tracks, each with a playable preview and its licence page", () => {
    expect(MUSIC_CANDIDATES).toHaveLength(54);
    expect(new Set(MUSIC_CANDIDATES.map((c) => c.num)).size).toBe(54);
    for (const c of MUSIC_CANDIDATES) {
      expect(c.audio).toMatch(/^https:\/\/(cdn\.pixabay\.com|assets\.mixkit\.co)\/.+\.mp3/);
      expect(c.page).toMatch(/^https:\/\/(pixabay\.com|mixkit\.co)\//);
      expect(Object.keys(MUSIC_GROUPS)).toContain(c.group);
    }
  });

  it("marks exactly ten of Claude's favourites", () => {
    expect(MUSIC_CANDIDATES.filter((c) => c.claudePick).map((c) => c.num)).toEqual([2, 7, 11, 16, 19, 23, 30, 37, 43, 50]);
  });
});

describe("parsePicks", () => {
  it("keeps only known track numbers, deduplicated and sorted", () => {
    expect(parsePicks(JSON.stringify({ nums: [19, 2, 19, 999, "7"], comment: "ok" }))).toEqual({ nums: [2, 7, 19], comment: "ok" });
  });
  it("never throws on missing or broken data", () => {
    expect(parsePicks(null)).toEqual({ nums: [], comment: "" });
    expect(parsePicks("{oops")).toEqual({ nums: [], comment: "" });
  });
});
