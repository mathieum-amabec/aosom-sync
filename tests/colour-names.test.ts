import { describe, it, expect } from "vitest";
import { toFrenchColour, toEnglishColour, isEnglishColour } from "@/lib/colour-names";
import { ensureVariantPrimaryImages, variantImageIndexes, MAX_IMAGES_WITH_VARIANT_PHOTOS } from "@/lib/variant-merger";
import type { AosomVariant } from "@/types/aosom";

describe("toFrenchColour", () => {
  it("translates whole phrases case-insensitively and keeps the disambiguation number", () => {
    expect(toFrenchColour("Rustic Brown")).toBe("Brun rustique");
    expect(toFrenchColour("WHITE")).toBe("Blanc");
    expect(toFrenchColour("Green 2")).toBe("Vert 2");
  });
  it("translates compounds part by part", () => {
    expect(toFrenchColour("Grey, White, Black")).toBe("Gris, blanc et noir");
    expect(toFrenchColour("Natural Wood and Black")).toBe("Bois naturel et noir");
  });
  it("leaves French labels and untranslatable values untouched", () => {
    expect(toFrenchColour("Gris foncé")).toBe("Gris foncé");
    expect(toFrenchColour("Plaid Tartan")).toBe("Plaid Tartan");
    expect(toFrenchColour("")).toBe("");
  });
});

describe("toEnglishColour / isEnglishColour", () => {
  it("translates French labels (and compounds) to English", () => {
    expect(toEnglishColour("Gris foncé")).toBe("Dark grey");
    expect(toEnglishColour("Gris foncé et blanc")).toBe("Dark grey and white");
    expect(toEnglishColour("Noir 2")).toBe("Black 2");
  });
  it("returns an English label as-is and null when unknown", () => {
    expect(toEnglishColour("Rustic Brown")).toBe("Rustic Brown");
    expect(toEnglishColour("Plaid Tartan")).toBeNull();
  });
  it("flags only English labels the FR store should not show", () => {
    expect(isEnglishColour("Black")).toBe(true);
    expect(isEnglishColour("Noir")).toBe(false);
    expect(isEnglishColour("Orange")).toBe(false); // same word in both languages
  });
});

const v = (sku: string, color: string, images: string[]): AosomVariant =>
  ({ sku, color, images, price: 1, qty: 1, size: "", gtin: "", weight: 0, dimensions: { length: 0, width: 0, height: 0 } }) as unknown as AosomVariant;

describe("ensureVariantPrimaryImages", () => {
  it("appends a colour's own photo when the 8-photo cap dropped it, once per colour", () => {
    const curated = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
    const out = ensureVariantPrimaryImages(curated, [
      v("A", "Noir", ["a1", "a2"]),
      v("B", "Blanc", ["b1", "b2"]),
      v("B2", "Blanc", ["b9"]), // same colour, other size → no extra photo
      v("C", "Gris", ["c1"]),
    ]);
    expect(out).toEqual([...curated, "b1", "c1"]);
  });
  it("never grows past the ceiling", () => {
    const curated = Array.from({ length: MAX_IMAGES_WITH_VARIANT_PHOTOS }, (_, i) => `x${i}`);
    expect(ensureVariantPrimaryImages(curated, [v("A", "Noir", ["new"])])).toHaveLength(MAX_IMAGES_WITH_VARIANT_PHOTOS);
  });
});

describe("variantImageIndexes", () => {
  it("points each variant at its first photo present in the gallery, -1 when none", () => {
    expect(variantImageIndexes(["a1", "b2", "c1"], [v("A", "Noir", ["a0", "a1"]), v("B", "Blanc", ["b1", "b2"]), v("D", "Rose", ["d1"])]))
      .toEqual([0, 1, -1]);
  });
});
