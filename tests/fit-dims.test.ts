import { describe, it, expect } from "vitest";
import { lengthToCm, parseBoxSizes, buildFitDims, serializeFitDims, parseCmTriple, sizesAgree, checkAgainstPage } from "@/lib/fit-dims";

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
