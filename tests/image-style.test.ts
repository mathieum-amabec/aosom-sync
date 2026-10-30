import { describe, it, expect } from "vitest";
import { styleFromPixels } from "@/lib/image-style";

const SIZE = 100;
/** Build a 100×100 RGB thumbnail: `paint(x, y)` returns the grey level of each pixel. */
function thumb(paint: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const v = paint(x, y);
    data.set([v, v, v], (y * SIZE + x) * 3);
  }
  return data;
}

describe("styleFromPixels", () => {
  it("a product centred on a white background is studio", () => {
    expect(styleFromPixels(thumb((x, y) => (x > 20 && x < 80 && y > 20 && y < 80 ? 60 : 255)), 3)).toBe("studio");
  });

  it("a product touching the frame edges but with white corners is still studio", () => {
    // Border is mostly the dark product (the old border-only test called this lifestyle),
    // yet all four corners are white.
    const recliner = thumb((x, y) => {
      const corner = (x < 12 || x >= 88) && (y < 12 || y >= 88);
      return corner ? 255 : 70;
    });
    expect(styleFromPixels(recliner, 3)).toBe("studio");
  });

  it("a room photo with no white corners is lifestyle", () => {
    expect(styleFromPixels(thumb((x, y) => 120 + ((x * 7 + y * 3) % 90)), 3)).toBe("lifestyle");
  });

  it("one bright corner (a window) is not enough to call it studio", () => {
    const room = thumb((x, y) => (x < 15 && y < 15 ? 255 : 150));
    expect(styleFromPixels(room, 3)).toBe("lifestyle");
  });
});
