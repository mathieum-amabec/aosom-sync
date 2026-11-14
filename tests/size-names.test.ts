import { describe, it, expect } from "vitest";
import { toFrenchSize } from "@/lib/size-names";

describe("toFrenchSize (FR store size labels, 2026-10-02)", () => {
  it.each([
    ["Large", "Grand"], ["Medium", "Moyen"], ["Small", "Petit"], ["One Size", "Taille unique"],
    ["Set of 4", "Lot de 4"], ["3-Drawer", "3 tiroirs"], ["1-Drawer", "1 tiroir"], ["2 Doors", "2 portes"],
    ["7-Tier", "7 étages"], ["6 Panel", "6 panneaux"], ["6FT", "6 pi"], ["7.5FT", "7,5 pi"],
    ["1 Count (Pack of 1)", "1 unité(s)"], ["Two Seat", "2 places"], ["Twin", "Simple"], ["Full", "Double"],
    ["4.5' x 6' (Without Foundation Kit)", "4.5' x 6' (sans kit de fondation)"],
  ])("%s → %s", (en, fr) => expect(toFrenchSize(en)).toBe(fr));

  it("leaves inch marks, metric units and unknown values exactly as they are", () => {
    for (const v of ['23.6" x 9.4" x 72.6"', "95L x 71.5W x 102H cm", "Queen", "King", "Lot de 2", ""]) {
      expect(toFrenchSize(v)).toBe(v);
    }
  });
});
