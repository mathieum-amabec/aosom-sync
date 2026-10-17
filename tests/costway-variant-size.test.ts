import { describe, expect, it } from "vitest";
import { sizeFromTitle, sizeRank, stripVariantSize, variantSizes } from "@/lib/costway/variant-size";
import { toFrenchSize } from "@/lib/size-names";

const v = (title: string, color = "Green", sku = "X") => ({ title, color, sku });

describe("sizeFromTitle — real Costway titles (2026-10-17 audit)", () => {
  it.each([
    ["PVC Artificial Slim Pencil Christmas Tree-7 Feet", "7 ft (213 cm)"],
    ["6/7.5/9 Feet Pre-Lit Artificial Christmas Tree Snow Flocked Hinged-7.5 Feet", "7.5 ft (229 cm)"],
    ["Pre-Lit Hinged Christmas Tree with Remote Control Lights-6'", "6 ft (183 cm)"],
    ["8 FT Pre-Lit Artificial Christmas Tree Hinged Xmas Tree with 400 Warm White & Multicolored LED Lights", "8 ft (244 cm)"],
    ["Smart WiFi Electric Fireplace Wall Mounted & Recessed 750W/1500W Heater-42 Inch", "42 inches (107 cm)"],
    ['30/36/40/50/60/72 Inch Smart WiFi Electric Fireplace with Recessed and Wall Mounted-50"', "50 inches (127 cm)"],
    ["30 Inch Smart WiFi Electric Fireplace with Recessed and Wall Mounted", "30 inches (76 cm)"],
    ["33/36-Inch Electric Fireplace Insert 750W/1500W Recessed Fireplace Heater-1500W", "1500W"],
    ["Twin/Full/Queen Size Metal Bed Frame with Headboard and Footboard-Full Size", "Full"],
    ["Queen Size Velvet Bed Frame Upholstered Platform Bed with Chevron Headboard Beige", "Queen"],
    ["70/90 Pint 4500/6000 Sq. Ft Dehumidifier with Continuous and Auto Mode-90 Pints", "90 pints"],
    ["Set of 1/2 4 FT Artificial Christmas Tree Potted Xmas Tree with 190 Branch Tips-Set of 2", "Set of 2"],
    ["Set of 1 Boho Nightstand with Charging Station and RGB LED Light Strip", "1 piece"],
    ["Anti-Fog Round Led Bathroom Mirror with 3 Color LED Lights-M", "Medium"],
  ])("%s → %s", (title, size) => {
    expect(sizeFromTitle(title)).toBe(size);
  });

  it("a colour suffix is not a size", () => {
    expect(sizeFromTitle("Twin Over Full House Bunk Bed with Ladder and Guardrails-White")).toBe("");
  });
});

describe("variantSizes", () => {
  it("colours already distinct → no size option", () => {
    expect(variantSizes([v("Bunk Bed-White", "White"), v("Bunk Bed-Gray", "Gray")])).toEqual(["", ""]);
  });

  it("same colour, sizes in the suffix", () => {
    expect(variantSizes([v("Tree-5 ft"), v("Tree-6 ft")])).toEqual(["5 ft (152 cm)", "6 ft (183 cm)"]);
  });

  it("bed size missing from one title comes from the SKU suffix", () => {
    expect(
      variantSizes([
        v("Queen Size Platform Bed Frame with Adjustable Headboard", "Gray", "43987620_HU10229GR-Q"),
        v("Platform Bed Frame with Adjustable Headboard", "Gray", "43987620_HU10229GR-F"),
      ]),
    ).toEqual(["Queen", "Full"]);
  });

  it("S/M/L on a family that lists its sizes → the real sizes", () => {
    const t = "6/7/8 FT Artificial Christmas Tree with 568/830/1182 Branch Tips and 200/250/400 Warm White LED Lights";
    expect(variantSizes([v(`${t}-M`), v(`${t}-L`), v(`${t}-XL`)])).toEqual(["6 ft (183 cm)", "7 ft (213 cm)", "8 ft (244 cm)"]);
  });

  it("nothing tells two same-colour variants apart → null (do not import)", () => {
    expect(variantSizes([v("Tree with lights"), v("Tree with more lights")])).toBeNull();
  });

  it("French labels through toFrenchSize", () => {
    expect(toFrenchSize("7.5 ft (229 cm)")).toBe("7,5 pi (229 cm)");
    expect(toFrenchSize("36 inches (91 cm)")).toBe("36 po (91 cm)");
    expect(toFrenchSize("Set of 2")).toBe("Lot de 2");
    expect(toFrenchSize("1 piece")).toBe("1 pièce");
    expect(toFrenchSize("Full")).toBe("Double");
    expect(toFrenchSize("90 pints")).toBe("90 pintes");
  });

  it("sizeRank orders smallest first", () => {
    const s = ["Queen", "Twin", "Full"].sort((a, b) => sizeRank(a) - sizeRank(b));
    expect(s).toEqual(["Twin", "Full", "Queen"]);
    expect(sizeRank("6 ft (183 cm)")).toBeLessThan(sizeRank("7.5 ft (229 cm)"));
  });
});

describe("stripVariantSize", () => {
  const opts = (sizes: string[], supplierTexts: string[] = []) => ({ sizes, supplierTexts });

  it("drops the single size from a multi-size title", () => {
    expect(stripVariantSize("Arbre de Noël artificiel mince 152 cm", opts(["5 ft (152 cm)", "6 ft (183 cm)"]))).toBe(
      "Arbre de Noël artificiel mince",
    );
    expect(stripVariantSize("Arbre de Noël artificiel pré-éclairé de 213 cm — Lot de 4", opts(["7 ft (213 cm)", "8 ft (244 cm)"]))).toBe(
      "Arbre de Noël artificiel pré-éclairé",
    );
    expect(stripVariantSize("Lit plateforme queen avec tête de lit réglable", opts(["Full", "Queen"]))).toBe(
      "Lit plateforme avec tête de lit réglable",
    );
  });

  it("drops a set the supplier never claimed, keeps one it did", () => {
    expect(stripVariantSize("Lit superposé cabane en bois — Lot de 2", opts(["", ""], ["Twin Over Full House Bunk Bed"]))).toBe(
      "Lit superposé cabane en bois",
    );
    expect(stripVariantSize("Chaises de salle à manger — Lot de 2", opts(["", ""], ["Set of 2 Dining Chairs"]))).toBe(
      "Chaises de salle à manger — Lot de 2",
    );
  });

  it("leaves a single-size product alone", () => {
    expect(stripVariantSize("Foyer électrique de 91 cm", opts(["", ""], ["Set of 2"]))).toBe("Foyer électrique de 91 cm");
  });
});
