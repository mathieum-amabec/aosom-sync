import { describe, it, expect } from "vitest";
import { lengthToCm, parseBoxSizes, buildFitDims, serializeFitDims, parseCmTriple, sizesAgree, checkAgainstPage, extractSupplierSize, metricCues, reconcileUnits, feedUnitOf, harmonizeSiblings } from "@/lib/fit-dims";

describe("lengthToCm", () => {
  it("converts each unit the feed uses", () => {
    expect(lengthToCm("47.80 in")).toBe(121.4);
    expect(lengthToCm("10.00 ft")).toBe(304.8);
    expect(lengthToCm("120.00 cm")).toBe(120);
    expect(lengthToCm("47,8 in")).toBe(121.4);
  });
  it("reads a bare number as inches (the feed's historical default)", () => {
    expect(lengthToCm(20)).toBe(50.8);
  });
  it("rejects empty, zero and unknown units", () => {
    expect(lengthToCm("")).toBeNull();
    expect(lengthToCm("0.00 in")).toBeNull();
    expect(lengthToCm("12 yards")).toBeNull();
    expect(lengthToCm(undefined)).toBeNull();
  });
});

describe("parseBoxSizes", () => {
  it("splits multi-box products and sorts each box smallest first", () => {
    expect(parseBoxSizes("132.50x61.50x8.50 cm|85.70x56.00x15.50 cm")).toEqual([
      [8.5, 61.5, 132.5],
      [15.5, 56, 85.7],
    ]);
  });
  it("skips malformed boxes", () => {
    expect(parseBoxSizes("88x25 cm|bad|10x20x30 cm")).toEqual([[10, 20, 30]]);
    expect(parseBoxSizes("")).toEqual([]);
  });
});

describe("parseCmTriple / sizesAgree", () => {
  it("reads the first cm triple of a description, French decimals included", () => {
    expect(parseCmTriple("<li>Dimensions: 99,8 x 35,1 x 64,8 cm (39,3 x 13,8 x 25,5 po)</li>")).toEqual([99.8, 35.1, 64.8]);
    expect(parseCmTriple("no size here")).toBeNull();
  });
  it("agrees within 3 % in any order, disagrees on a real mismatch", () => {
    expect(sizesAgree([120.1, 50.3, 74.9], [120, 50, 75])).toBe(true);
    expect(sizesAgree([50.3, 120.1, 74.9], [120, 50, 75])).toBe(true);
    // feed "47.2 cm" that is really inches vs the page's 120 x 90 x 30 cm
    expect(sizesAgree([47.2, 35.4, 11.8], [120, 90, 30])).toBe(false);
  });
});

describe("checkAgainstPage", () => {
  const dims = { v: 1 as const, s: { A: { p: [120.1, 50.3, 74.9] as [number, number, number] } } };
  it("keeps sizes that match the page, or when the page states none", () => {
    expect(checkAgainstPage(dims, "Dimensions: 120 x 50 x 75 cm")).toBe(dims);
    expect(checkAgainstPage(dims, "Un beau meuble.")).toBe(dims);
  });
  it("drops sizes that contradict the page", () => {
    expect(checkAgainstPage(dims, "Dimensions: 61 x 35 x 25 cm")).toBeNull();
    expect(checkAgainstPage(null, "x")).toBeNull();
  });
});

describe("extractSupplierSize (Costway descriptions)", () => {
  it("reads a labelled L x W x H triple in inches and converts to cm", () => {
    expect(extractSupplierSize("<li>The overall dimension of the sofa: is 94.5” x 32.5” x 32.5” (L x W x H)</li>")).toEqual([240, 82.6, 82.6]);
    expect(extractSupplierSize("Product Dimensions: 21 x 20.5 x 31 inch (L x W x H)")).toEqual([53.3, 52.1, 78.7]);
    expect(extractSupplierSize("Overall Dimension: 120 x 60 x 75 cm")).toEqual([120, 60, 75]);
  });
  it("skips parcel and part sizes and picks the item's own size", () => {
    expect(extractSupplierSize("Package Dimensions: 40\" x 20\" x 10\" ● Overall Dimension: 30\" x 15\" x 12\"")).toEqual([76.2, 38.1, 30.5]);
    expect(extractSupplierSize("Inner size of big drawer: 25.5\" x 20\" x 5\" (L x W x H)")).toBeNull();
    expect(extractSupplierSize("Size of Flowerpot 7.5” x 7.5” x 10.5”")).toBeNull();
  });
  it("returns null without a label, or for an implausible size", () => {
    expect(extractSupplierSize("Measuring 23\" x 15\" x 14\" this unit fits anywhere")).toBeNull();
    expect(extractSupplierSize("Overall Dimension: 900\" x 2\" x 3\"")).toBeNull();
    expect(extractSupplierSize(null)).toBeNull();
  });
});

describe("buildFitDims", () => {
  it("keys entries by SKU, product size in cm as [width, depth, height]", () => {
    const d = buildFitDims([
      { sku: "836-439", length: "47.30 in", width: "19.80 in", height: "29.50 in", boxSize: "132.50x61.50x8.50 cm|85.70x56.00x15.50 cm" },
      { sku: "NO-DIMS", length: "", width: "19.80 in", height: "29.50 in" },
    ]);
    expect(d).toEqual({ v: 1, s: { "836-439": { p: [120.1, 50.3, 74.9], b: [[8.5, 61.5, 132.5], [15.5, 56, 85.7]] } } });
  });
  it("returns null when no SKU has a full size (nothing to store)", () => {
    expect(buildFitDims([{ sku: "X", length: "", width: "", height: "" }])).toBeNull();
  });
  it("serializes with sorted SKUs so unchanged products compare equal", () => {
    const a = serializeFitDims({ v: 1, s: { B: { p: [1, 2, 3] }, A: { p: [4, 5, 6] } } });
    const b = serializeFitDims({ v: 1, s: { A: { p: [4, 5, 6] }, B: { p: [1, 2, 3] } } });
    expect(a).toBe(b);
    expect(a.indexOf('"A"')).toBeLessThan(a.indexOf('"B"'));
  });
});

// 2026-11-19: Aosom labels some feet values "in" (a 9.1 FOOT shed read "9.10 in" → 23 × 16 × 16 cm on the product page)
// and some cm values "in". The unit label can't be trusted, the product's own text and its parcel can.
describe("unit slips in the feed (reconcileUnits)", () => {
  const SHED_BOXES = "163.00x59.00x9.00 cm|166.00x48.00x5.50 cm|143.00x37.00x11.00 cm";
  it("the shed: '9.10 in' is 9.1 ft, caught by its own parcel even with no size in the text", () => {
    const d = buildFitDims([{ sku: "845-031GN", length: "9.10 in", width: "6.40 in", height: "6.30 in", boxSize: SHED_BOXES }], "Remise de jardin en acier galvanisé portes coulissantes");
    expect(d!.s["845-031GN"].p).toEqual([277.2, 195.6, 192]);
  });
  it("the title's own metric size picks the right unit", () => {
    const d = buildFitDims([{ sku: "G", length: "6.20 in", width: "6.20 in", height: "6.60 in" }], "Serre 190x190x200cm polycarbonate");
    expect(d!.s.G.p.map(Math.round)).toEqual([188, 188, 202]);
  });
  it("a 'in' value that is really cm (194 cm lounger stored as 492 cm) is divided back", () => {
    const d = buildFitDims([{ sku: "L", length: "194.00 in", width: "72.00 in", height: "31.00 in" }], "Chaise longue 194 x 72 x 31 cm");
    expect(d!.s.L.p.map(Math.round)).toEqual([194, 72, 31]);
  });
  it("a value that already matches the title is left alone", () => {
    const d = buildFitDims([{ sku: "OK", length: "47.80 in", width: "19.70 in", height: "29.50 in" }], "Table 121 x 50 x 75 cm");
    expect(d!.s.OK.p).toEqual([121.4, 50, 74.9]);
  });
  it("an inflatable far taller than its parcel is NOT 'fixed' (no text, ×12 would be absurd)", () => {
    const d = buildFitDims([{ sku: "I", length: "64.30 in", width: "45.20 in", height: "179.80 in", boxSize: "22.5x20x25 cm" }]);
    expect(d!.s.I.p[2]).toBe(456.7);
  });
  it("ambiguous slips drop the size instead of guessing", () => {
    const e = { p: [49.5, 24.9, 17.5] as [number, number, number] };
    expect(reconcileUnits(e, [[49.5 * 12, 24.9 * 12, 17.5 * 12], [49.5 / 2.54, 24.9 / 2.54, 17.5 / 2.54]])).toBeNull();
  });
  it("metricCues reads cm, m and comma decimals", () => {
    expect(metricCues("Serre 6x3x2m, 1,5 x 2 m et 190 x 190 x 200 cm")).toEqual([[600, 300, 200], [150, 200], [190, 190, 200]]);
  });
});

describe("unit slips respect the label the value carried (review 2026-11-19)", () => {
  it("a bar stool listed as 6.60 in x 5.50 in x 13.30 in (really 43 x 36 x 86 cm: converted to inches twice) is fixed from its parcel", () => {
    const d = buildFitDims([{ sku: "S", length: "6.60 in", width: "5.50 in", height: "13.30 in", boxSize: "68x27x38.5 cm" }]);
    expect(d!.s.S.p).toEqual([42.7, 35.6, 85.9]);
  });
  it("a cm label is never read as feet", () => {
    const r = reconcileUnits({ p: [20, 20, 20], b: [[60, 60, 80]] }, [], "cm");
    expect(r!.fix).toBe(2.54);
  });
  it("a 'cm' value that is really inches is x2.54 only when its parcel says so", () => {
    const d = buildFitDims([{ sku: "T", length: "27.60 cm", width: "27.60 cm", height: "29.50 cm", boxSize: "75x40x15 cm" }]);
    expect(d!.s.T.p).toEqual([70.1, 70.1, 74.9]);
  });
  it("feedUnitOf reads the label, a bare number is inches", () => {
    expect(feedUnitOf("47.80 in")).toBe("in");
    expect(feedUnitOf("120.00 cm")).toBe("cm");
    expect(feedUnitOf("10.00 ft")).toBe("ft");
    expect(feedUnitOf("47.8")).toBe("in");
  });
  it("a quantity or an area is not a size cue", () => {
    expect(metricCues("Lot de 2 x 140 x 240 cm")).toEqual([]);
    expect(metricCues("Tapis 3 x 3 m² antidérapant")).toEqual([]);
    expect(metricCues("Tapis 3 x 3 m antidérapant")).toEqual([[300, 300]]);
  });
});

describe("size cues with letters, inches and feet; sibling consistency (review 2026-11-19)", () => {
  it("reads labels with dimension letters", () => {
    expect(metricCues("Noir / 65 l × 72 P × 117 H cm")).toEqual([[65, 72, 117]]);
    expect(metricCues("87 L × 46 l × 97 H cm")).toEqual([[87, 46, 97]]);
    expect(metricCues("347 cm (L) x 160 cm (l) x 150 cm (H)")).toEqual([[347, 160, 150]]);
  });
  it("reads inches and feet", () => {
    expect(metricCues('Beige / 30.7" x 32.7" x 39.8"')).toEqual([[78, 83.1, 101.1]]);
    expect(metricCues("Rideaux 10 pi x 12 pi")).toEqual([[304.8, 365.8]]);
  });
  it("ignores a size with no unit at all", () => {
    expect(metricCues("Taille 10 x 12")).toEqual([]);
  });
  it("a label in letters now fixes a slipped size", () => {
    const d = buildFitDims([{ sku: "C", length: "72.00 in", width: "65.00 in", height: "117.00 in" }], "Noir / 65 l × 72 P × 117 H cm");
    expect(d!.s.C.p.map(Math.round)).toEqual([72, 65, 117]);
  });
  it("two colours that differ by exactly x2.54 are one product: the one far from its parcel is rescaled", () => {
    const s = {
      CW: { p: [30.7, 32.7, 39.8] as [number, number, number], b: [[60, 70, 100]] as [number, number, number][] },
      BU: { p: [78, 83.1, 101.1] as [number, number, number], b: [[60, 70, 100]] as [number, number, number][] },
    };
    harmonizeSiblings(s);
    expect(s.CW.p).toEqual([78, 83.1, 101.1]);
    expect(s.BU.p).toEqual([78, 83.1, 101.1]);
  });
  it("genuinely different sizes are left alone", () => {
    const s = {
      S: { p: [60, 40, 30] as [number, number, number], b: [[60, 40, 30]] as [number, number, number][] },
      L: { p: [90, 60, 45] as [number, number, number], b: [[90, 60, 45]] as [number, number, number][] },
    };
    harmonizeSiblings(s);
    expect(s.S.p).toEqual([60, 40, 30]);
  });
});

describe("apostrophe is not feet (stool seat 18.5x22' = inches)", () => {
  it("is no cue, and the stool keeps its size", () => {
    expect(metricCues("Gris / 18.5x22'")).toEqual([]);
    const d = buildFitDims([{ sku: "835-030", length: "18.50 in", width: "22.00 in", height: "39.80 in", boxSize: "67x49x56 cm" }], "Gris / 18.5x22'");
    expect(d!.s["835-030"].p).toEqual([47, 55.9, 101.1]);
  });
});
