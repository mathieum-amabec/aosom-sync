import { describe, it, expect } from "vitest";
import {
  W, H, BAR_H, DURATION, WINDOWS,
  textBand, gradientRect, hashSku, pickMusic, fitText, layoutWords, textWidth,
  buildAdGraph, buildAudioGraph, musicFamilyFor, MUSIC_FAMILIES, DEFAULT_FAMILY, TRACK_GAIN, type ProductZone,
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
    const a = buildAudioGraph(1, { track: "x.mp3", startOffset: 12, tempo: 1.04, gain: 1 });
    expect(a).toContain("atempo=1.04");
    expect(a).toContain(`st=${(DURATION - 1).toFixed(2)}`);
    expect(a).toContain("[aout]");
  });
});

describe("music families by product category", () => {
  const ALL = [
    "C:/a/joyinsound-no-copyright-chill-music-403411.mp3",
    "C:/a/sigmamusicart-no-copyright-music-514564.mp3",
    "C:/a/mixkit-lounge-695.mp3",
    // Retired from automatic selection but still on disk — kept in the fixture precisely
    // so the retirement tests below have something to exclude.
    "C:/a/mixkit-corporate-22.mp3",
    "C:/a/mixkit-golden-storm-470.mp3",
    "C:/a/mixkit-pop-250.mp3",
    "C:/a/mixkit-funk-1140.mp3",
  ];
  // Windows paths on purpose: production builds these with path.join, so they carry
  // backslashes. An earlier fixture used forward slashes and let through a base() that only
  // split on "/" — every family then fell back to the whole pool, silently.
  const BS = String.fromCharCode(92);
  const WINPATHS = ALL.map((p) => p.split("/").join(BS));
  const base = (p: string) => {
    const k = Math.max(p.lastIndexOf("/"), p.lastIndexOf(BS));
    return k >= 0 ? p.slice(k + 1) : p;
  };

  it("maps each area of the taxonomy to its family", () => {
    expect(musicFamilyFor("Patio & Garden > Patio Furniture > Sofas")).toBe("exterieur");
    expect(musicFamilyFor("Pet Supplies > Dogs > Dog Sofas")).toBe("animaux");
    expect(musicFamilyFor("Toys & Games > Baby & Toddler Toys")).toBe("enfants");
    expect(musicFamilyFor("Office Products > Office Furniture > Office Desks")).toBe("bureau");
    expect(musicFamilyFor("Home Furnishings > Storage & Organization > Shelving")).toBe("bureau");
    expect(musicFamilyFor("Home Furnishings > Living Room Furniture > Sofas")).toBe("interieur");
    expect(musicFamilyFor("Home Furnishings > Bedroom Furniture > Beds")).toBe("interieur");
  });

  // Storage is Home Furnishings too, so order matters: it must not fall through to interieur.
  it("routes storage to bureau even though it lives under Home Furnishings", () => {
    expect(musicFamilyFor("Home Furnishings > Storage & Organization > Storage Cabinets")).toBe("bureau");
  });

  it("falls back rather than guessing on an unknown or empty product type", () => {
    expect(musicFamilyFor(null)).toBe(DEFAULT_FAMILY);
    expect(musicFamilyFor("")).toBe(DEFAULT_FAMILY);
    expect(musicFamilyFor("Sports & Recreation > Exercise Equipment")).toBe(DEFAULT_FAMILY);
  });

  it("picks a bed from the product's own family", () => {
    expect(base(pickMusic("X", WINPATHS, "Pet Supplies > Dogs").track)).toBe("mixkit-funk-1140.mp3");
    expect(base(pickMusic("X", WINPATHS, "Toys & Games > Ride-On").track)).toBe("mixkit-pop-250.mp3");
    expect(base(pickMusic("X", WINPATHS, "Office Products > Desks").track)).toBe("mixkit-golden-storm-470.mp3");
    expect(base(pickMusic("X", WINPATHS, "Home Furnishings > Living Room Furniture").track)).toBe("mixkit-lounge-695.mp3");
  });

  // The identity that already shipped on every published patio ad must not move.
  it("keeps outdoor on the two original beds", () => {
    for (const sku of ["A", "B", "C", "D", "E"]) {
      const t = base(pickMusic(sku, WINPATHS, "Patio & Garden > Sheds").track);
      expect(["joyinsound-no-copyright-chill-music-403411.mp3", "sigmamusicart-no-copyright-music-514564.mp3"]).toContain(t);
    }
  });

  it("still desynchronises WITHIN a family — same track, different entry points", () => {
    const picks = ["A", "B", "C", "D", "E", "F", "G", "H"].map((s) =>
      pickMusic(s, WINPATHS, "Pet Supplies > Dogs"),
    );
    expect(new Set(picks.map((p) => base(p.track))).size).toBe(1);
    expect(new Set(picks.map((p) => `${p.startOffset}-${p.tempo}`)).size).toBeGreaterThanOrEqual(4);
  });

  it("stays deterministic", () => {
    const a = pickMusic("836-068WT", WINPATHS, "Office Products > Desks");
    const b = pickMusic("836-068WT", WINPATHS, "Office Products > Desks");
    expect(a).toEqual(b);
  });

  // The mp3s are gitignored: a clone without them must still render, just unthemed.
  it("degrades to the whole pool when the family's file is missing on disk", () => {
    const only = ["C:/a/sigmamusicart-no-copyright-music-514564.mp3"];
    const m = pickMusic("X", only, "Pet Supplies > Dogs");
    expect(base(m.track)).toBe("sigmamusicart-no-copyright-music-514564.mp3");
    expect(m.family).toMatch(/repli/);
  });

  it("reports the family it actually used", () => {
    expect(pickMusic("X", WINPATHS, "Pet Supplies > Dogs").family).toBe("animaux");
  });

  // Retiring a bed by deleting the file only works on the machine that deletes it: src/audio
  // is gitignored, so every other clone still has it and the fallback enumerates the folder.
  describe("retired beds", () => {
    const RETIRED = "mixkit-corporate-22.mp3";

    it("is gone from every family", () => {
      for (const files of Object.values(MUSIC_FAMILIES)) expect(files).not.toContain(RETIRED);
    });

    it("never surfaces through the no-family fallback", () => {
      // Exercise Equipment matches no family, so these all take the fallback path.
      for (let i = 0; i < 60; i++) {
        const m = pickMusic("SKU-" + i, WINPATHS, "Sports & Recreation > Exercise Equipment");
        expect(base(m.track), "retired bed resurfaced via the fallback").not.toBe(RETIRED);
      }
    });

    it("still covers the pool — the fallback keeps choosing, it does not collapse to one bed", () => {
      const picked = new Set(
        Array.from({ length: 60 }, (_, i) =>
          base(pickMusic("SKU-" + i, WINPATHS, "Sports & Recreation > Exercise Equipment").track),
        ),
      );
      expect(picked.size).toBeGreaterThan(1);
      expect(picked.has(RETIRED)).toBe(false);
    });

    it("yields rather than crashing when the retired bed is the ONLY file on disk", () => {
      // pickMusic throws on an empty pool, and a thrown render is worse than a dull bed.
      const only = ["C:/a/" + RETIRED];
      expect(base(pickMusic("X", only, "Sports & Recreation > Exercise Equipment").track)).toBe(RETIRED);
    });

    it("keeps its gain, so an explicit use is still level-matched", () => {
      expect(TRACK_GAIN[RETIRED]).toBeGreaterThan(0);
    });
  });

  it("every family names at least one track, and no track is orphaned", () => {
    const known = new Set(ALL.map(base));
    for (const [fam, files] of Object.entries(MUSIC_FAMILIES)) {
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(known.has(f), `${fam} -> ${f} absent du pool`).toBe(true);
    }
  });
});

describe("level matching", () => {
  it("gives every pooled track a gain — an unmeasured track would ship at the wrong level", () => {
    for (const files of Object.values(MUSIC_FAMILIES)) {
      for (const f of files) expect(TRACK_GAIN[f], f).toBeGreaterThan(0);
    }
  });

  it("raises the quiet beds and leaves the loudest roughly alone", () => {
    expect(TRACK_GAIN["mixkit-funk-1140.mp3"]).toBeGreaterThan(TRACK_GAIN["mixkit-corporate-22.mp3"]);
    expect(TRACK_GAIN["joyinsound-no-copyright-chill-music-403411.mp3"]).toBeLessThan(1.2);
  });

  it("never pushes the mix into clipping", () => {
    for (const g of Object.values(TRACK_GAIN)) expect(0.22 * g).toBeLessThan(1);
  });

  it("applies the gain in the audio graph", () => {
    const a = buildAudioGraph(1, { track: "mixkit-funk-1140.mp3", startOffset: 0, tempo: 1, gain: 2.85 });
    expect(a).toContain("volume=0.627");
  });

  it("falls back to unity gain for a track with no measurement", () => {
    const a = buildAudioGraph(1, { track: "inconnu.mp3", startOffset: 0, tempo: 1, gain: 1 });
    expect(a).toContain("volume=0.22");
  });
});