import { describe, it, expect } from "vitest";
import { pickRandomImages } from "@/jobs/job4-social";

describe("pickRandomImages", () => {
  it("returns empty array when product has no images", () => {
    expect(pickRandomImages({})).toEqual([]);
    expect(pickRandomImages({ image1: "", image2: "  " })).toEqual([]);
  });

  it("caps selection at the number of available images", () => {
    const product = { image1: "a", image2: "b" };
    for (let i = 0; i < 50; i++) {
      const picked = pickRandomImages(product);
      expect(picked.length).toBeGreaterThanOrEqual(1);
      expect(picked.length).toBeLessThanOrEqual(2);
      for (const u of picked) expect(["a", "b"]).toContain(u);
    }
  });

  it("never picks more than 5 even when 7 are available", () => {
    const product = {
      image1: "a", image2: "b", image3: "c", image4: "d",
      image5: "e", image6: "f", image7: "g",
    };
    for (let i = 0; i < 100; i++) {
      const picked = pickRandomImages(product);
      expect(picked.length).toBeGreaterThanOrEqual(1);
      expect(picked.length).toBeLessThanOrEqual(5);
      expect(new Set(picked).size).toBe(picked.length);
    }
  });

  it("varies the count across many runs (not always the same N)", () => {
    const product = {
      image1: "a", image2: "b", image3: "c", image4: "d", image5: "e",
    };
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) counts.add(pickRandomImages(product).length);
    // With 5 images and 200 samples, we should see multiple different counts.
    expect(counts.size).toBeGreaterThanOrEqual(2);
  });

  it("varies the order across runs (shuffle is applied)", () => {
    const product = {
      image1: "a", image2: "b", image3: "c", image4: "d", image5: "e",
    };
    const firsts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const picked = pickRandomImages(product);
      if (picked.length > 0) firsts.add(picked[0]);
    }
    // Over 200 runs, the first element should not always be "a".
    expect(firsts.size).toBeGreaterThanOrEqual(2);
  });
});
