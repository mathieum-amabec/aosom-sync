import { describe, it, expect } from "vitest";
import {
  W, H, BAR_H, DURATION, WINDOWS,
  textBand, gradientRect, hashSku, pickMusic, fitText, layoutWords, textWidth,
  buildAdGraph, buildAudioGraph, type ProductZone,
} from "@/lib/video-ad-composer";

const TRACKS = ["a.mp3", "b.mp3"];
const ZONES: ProductZone[] = ["top", "middle", "bottom"];

describe("layout geometry", () => {
  it("keeps the text band clear of the brand bar", () => {
    for (const z of ZONES) {
      const b = textBand(z);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(H - BAR_H);
    }
  });

  // The whole reason for asking Vision where the product is.
  it("moves the copy to the TOP when the product sits low in frame", () => {
    expect(textBand("bottom").y).toBeLessThan(H / 2);
    expect(textBand("middle").y).toBeGreaterThan(H / 2);
    expect(textBand("top").y).toBeGreaterThan(H / 2);
  });

  it("covers under a quarter of the frame — the v2 slab was 46%", () => {
    for (const z of ZONES) expect(textBand(z).height / H).toBeLessThan(0.25);
  });

  it("puts the gradient over the text band, flipped when the copy is at the top", () => {
    const low = gradientRect("bottom");
    expect(low.flip).toBe(true);
    expect(low.y).toBe(0);
    const mid = gradientRect("middle");
    expect(mid.flip).toBe(false);
    expect(mid.y).toBeLessThan(textBand("middle").y);
    expect(mid.y + mid.height).toBeLessThanOrEqual(H);
  });
});

describe("pickMusic", () => {
  it("is deterministic — a re-render gets the same bed", () => {
    expect(pickMusic("836-068WT", TRACKS)).toEqual(pickMusic("836-068WT", TRACKS));
  });

  it("stays inside musical bounds", () => {
    for (const sku of ["A", "B", "C", "836-068WT", "D04-169", "833-804WT", "84J-283V00BK"]) {
      const m = pickMusic(sku, TRACKS);
      expect(TRACKS).toContain(m.track);
      expect(m.tempo).toBeGreaterThanOrEqual(0.94);
      expect(m.tempo).toBeLessThanOrEqual(1.08);
      expect(m.startOffset).toBeGreaterThanOrEqual(0);
      expect(m.startOffset).toBeLessThanOrEqual(42);
    }
  });

  // Two files are not two ads: offset and tempo are what stop a campaign sounding like a loop.
  it("gives 20 SKUs many distinct beds, not two", () => {
    const skus = Array.from({ length: 20 }, (_, i) => `SKU-${i}`);
    const combos = new Set(skus.map((s) => JSON.stringify(pickMusic(s, TRACKS))));
    expect(combos.size).toBeGreaterThanOrEqual(10);
  });

  it("throws rather than rendering a silent ad when no track exists", () => {
    expect(() => pickMusic("X", [])).toThrow(/no tracks/);
  });

  it("hashSku is stable, unsigned and discriminating", () => {
    expect(hashSku("abc")).toBe(hashSku("abc"));
    expect(hashSku("abc")).toBeGreaterThanOrEqual(0);
    expect(hashSku("abc")).not.toBe(hashSku("abd"));
  });
});

describe("fitText", () => {
  it("never returns more than 2 lines — the cap that keeps the product visible", () => {
    const long = "TON SALON ATTEND CETTE TABLE BASSE DEPUIS BEAUCOUP TROP LONGTEMPS ET IL FAUT AGIR";
    expect(fitText(long).lines.length).toBeLessThanOrEqual(2);
  });

  it("shrinks the font before wrapping to a second line", () => {
    const short = fitText("COURT");
    expect(short.lines).toHaveLength(1);
    expect(short.size).toBe(72);
  });

  it("keeps every line inside the safe width", () => {
    for (const t of ["UN", "TON BUREAU EST TROP PETIT POUR TOUT", "A".repeat(90)]) {
      const { lines, size } = fitText(t);
      for (const l of lines) expect(textWidth(l, size) - 1).toBeLessThanOrEqual(W - 150);
    }
  });

  it("truncates with an ellipsis rather than growing a third line", () => {
    const r = fitText("MOT ".repeat(60));
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.lines.join(" ")).toMatch(/…$/);
  });
});

describe("layoutWords", () => {
  // THE regression. Every word was given x=(w-text_w)/2, and drawtext centres each draw
  // independently, so the whole hook stacked on one spot and rendered as a smear.
  it("gives every word a DISTINCT x — they must not stack on each other", () => {
    const out = layoutWords("TON BUREAU EST TROP PETIT", 66, 0.15);
    const perLine = new Map<number, number[]>();
    for (const w of out) perLine.set(w.line, [...(perLine.get(w.line) ?? []), w.x]);
    for (const xs of perLine.values()) {
      expect(new Set(xs).size).toBe(xs.length);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    }
  });

  it("lays words out without overlapping, in reading order", () => {
    const size = 60;
    const line0 = layoutWords("UN DEUX TROIS QUATRE", size, 0).filter((w) => w.line === 0);
    for (let i = 1; i < line0.length; i++) {
      const prevEnd = line0[i - 1].x + textWidth(line0[i - 1].word, size);
      expect(line0[i].x).toBeGreaterThanOrEqual(prevEnd);
    }
  });

  it("centres each line inside the frame", () => {
    const size = 60;
    const out = layoutWords("UN DEUX", size, 0);
    const first = out[0], last = out[out.length - 1];
    const rightGap = W - (last.x + textWidth(last.word, size));
    expect(Math.abs(first.x - rightGap)).toBeLessThanOrEqual(2);
  });

  it("reveals words 0.1 s apart, in order", () => {
    expect(layoutWords("UN DEUX TROIS", 60, 0.15).map((w) => w.at)).toEqual([0.15, 0.25, 0.35]);
  });

  it("wraps to a second line rather than running off frame", () => {
    const out = layoutWords("ALPHA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL", 72, 0);
    expect(new Set(out.map((w) => w.line)).size).toBeGreaterThan(1);
    for (const w of out) expect(w.x).toBeGreaterThanOrEqual(0);
  });

  it("handles a single word and empty input", () => {
    expect(layoutWords("SEUL", 60, 0)).toHaveLength(1);
    expect(layoutWords("   ", 60, 0)).toEqual([]);
  });
});

describe("buildAdGraph", () => {
  const opts = {
    fontFile: "fonts/DMSans.ttf",
    lineFiles: [["h0.txt"], ["b0.txt"], ["p0.txt"], ["c0.txt"]],
    sizes: [66, 60, 66, 60],
    hookWordFiles: [
      { file: "hw0.txt", at: 0.15, x: 100, line: 0 },
      { file: "hw1.txt", at: 0.25, x: 300, line: 0 },
    ],
    zone: "middle" as ProductZone,
    navy: "0x1A2340",
    gold: "0xD4A853",
    idx: { clip: 0, music: 1, logo: 2, gradient: 3 },
  };

  it("ends on the [vout] label the mapping expects", () => {
    expect(buildAdGraph(opts)).toContain("[vout]");
  });

  it("front-loads the push-in instead of spreading it flat over 15 s", () => {
    const g = buildAdGraph(opts);
    expect(g).toContain("zoompan");
    expect(g).toMatch(/0\.07\*min\(on\/36/);
  });

  // The crash that shaped this module. Reproduced on a bare synthetic render.
  it("never emits an expression fontsize — that segfaults ffmpeg 8.1.1", () => {
    expect(buildAdGraph(opts)).not.toMatch(/fontsize='[^']*[t(]/);
  });

  it("draws the gold keyline as an animated WIDTH, which is the visible part", () => {
    expect(buildAdGraph(opts)).toMatch(/drawbox=x='\(1080-460\*/);
  });

  it("flashes at each message change", () => {
    const g = buildAdGraph(opts);
    for (const [s] of WINDOWS.slice(1)) expect(g).toContain(`between(t\\,${s.toFixed(2)}`);
    expect(g).toContain("white@0.55");
  });

  it("keeps the brand bar and the URL", () => {
    const g = buildAdGraph(opts);
    expect(g).toContain(`h=${BAR_H}`);
    expect(g).toContain("ameublodirect.ca");
  });

  it("has no opening black card — the ad starts on footage", () => {
    expect(buildAdGraph(opts)).not.toContain("concat");
  });

  it("places hook words at their given x, not centred on top of each other", () => {
    const g = buildAdGraph(opts);
    expect(g).toContain("x=100:");
    expect(g).toContain("x=300:");
  });

  it("escapes every comma inside a between() expression", () => {
    const g = buildAdGraph(opts);
    const found = g.match(/between\([^)]*\)/g) ?? [];
    expect(found.length).toBeGreaterThan(0);
    for (const b of found) expect(b).not.toMatch(/[^\\],/);
  });
});

describe("buildAudioGraph", () => {
  it("applies the picked tempo and fades out before the end", () => {
    const a = buildAudioGraph(1, { track: "x.mp3", startOffset: 12, tempo: 1.04 });
    expect(a).toContain("atempo=1.04");
    expect(a).toContain(`st=${(DURATION - 1).toFixed(2)}`);
    expect(a).toContain("[aout]");
  });
});
