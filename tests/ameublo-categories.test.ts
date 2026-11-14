import { describe, it, expect } from "vitest";
import { categorize, categoryOfType } from "@/lib/ameublo-categories";

const HALLOWEEN = "Home Furnishings > Holiday & Seasonal > Halloween Decorations";
const CAT_TREE = "Pet Supplies > Cat Supplies > Cat Trees";
const DOG_HOUSE = "Pet Supplies > Dog Supplies > Dog Houses";
const BAR_STOOL = "Home Furnishings > Kitchen & Dining Furniture > Bar Stools";
const DINING_CHAIR = "Home Furnishings > Kitchen & Dining Furniture > Dining Chairs";

describe("categoryOfType", () => {
  it("maps catalogue paths to a category", () => {
    expect(categoryOfType(HALLOWEEN)).toBe("halloween");
    expect(categoryOfType(CAT_TREE)).toBe("animaux");
    expect(categoryOfType(BAR_STOOL)).toBe("cuisine");
    expect(categoryOfType("Something > Else")).toBeNull();
  });
});

describe("categorize", () => {
  it("splits Halloween decor by what the on-screen title says, FR or EN", () => {
    expect(categorize({ productTypes: [HALLOWEEN], label: "Fantôme gonflable 6 pi" })).toEqual({ category: "halloween", sub: "Gonflables" });
    expect(categorize({ productTypes: [HALLOWEEN], label: "6 ft Inflatable Ghost" }).sub).toBe("Gonflables");
    expect(categorize({ productTypes: [HALLOWEEN], label: "Squelette suspendu en cage" }).sub).toBe("Suspendus");
    expect(categorize({ productTypes: [HALLOWEEN], label: "Clown animé 183 cm" }).sub).toBe("Animés");
    expect(categorize({ productTypes: [HALLOWEEN], label: "Trio de sorcières lumineuses" }).sub).toBe("Autres décors");
  });

  it("splits animals into cats and dogs", () => {
    expect(categorize({ productTypes: [CAT_TREE] })).toEqual({ category: "animaux", sub: "Chats" });
    expect(categorize({ productTypes: [DOG_HOUSE] })).toEqual({ category: "animaux", sub: "Chiens" });
  });

  it("gives a multi-product video the most common category and sub-category", () => {
    expect(categorize({ productTypes: [BAR_STOOL, BAR_STOOL, CAT_TREE] }).category).toBe("cuisine");
    expect(categorize({ productTypes: [BAR_STOOL, DINING_CHAIR, DINING_CHAIR] })).toEqual({
      category: "cuisine",
      sub: "Chaises de salle à manger",
    });
  });

  it("does not trust the campaign tag over the product type", () => {
    expect(categorize({ productTypes: [CAT_TREE], campaign: "maison-2026" }).category).toBe("animaux");
  });

  it("falls back to the campaign, then to Autres, when no product type is known", () => {
    expect(categorize({ productTypes: [], campaign: "halloween-2026", label: "Fantôme gonflable" }).category).toBe("halloween");
    expect(categorize({ productTypes: [], campaign: "maison-2026" })).toEqual({ category: "autres", sub: "Autres" });
  });
});
