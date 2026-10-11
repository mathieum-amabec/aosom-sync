import { describe, it, expect } from "vitest";
import { selectUncachedPhotos } from "@/lib/gallery-classification";

describe("selectUncachedPhotos", () => {
  const photos = [
    { stem: "a", url: "u-a" }, { stem: "b", url: "u-b" }, { stem: "a", url: "u-a2" },
    { stem: "", url: "u-empty" }, { stem: "c", url: "u-c" }, { stem: "d", url: "u-d" },
  ];
  it("dedups by stem, skips cached and empty stems, keeps first-seen order", () => {
    expect(selectUncachedPhotos(photos, new Set(["b"]), 99).map((p) => p.stem)).toEqual(["a", "c", "d"]);
  });
  it("caps at the limit", () => {
    expect(selectUncachedPhotos(photos, new Set(), 2).map((p) => p.stem)).toEqual(["a", "b"]);
  });
  it("returns nothing when everything is cached", () => {
    expect(selectUncachedPhotos(photos, new Set(["a", "b", "c", "d"]), 99)).toEqual([]);
  });
});
