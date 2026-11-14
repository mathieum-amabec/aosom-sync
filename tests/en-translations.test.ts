import { describe, it, expect } from "vitest";
import { rejectEnValue, looksFrench } from "@/lib/en-translations";

describe("rejectEnValue", () => {
  it("accepts clean English copy", () => {
    expect(rejectEnValue("Heavy-duty metal carport with a gable roof for your car.")).toBeNull();
  });
  it("rejects empty, supplier names, dollar prices and French text", () => {
    expect(rejectEnValue("  ")).toBe("vide");
    expect(rejectEnValue("Outsunny patio chair for the garden")).toMatch(/fournisseur/);
    expect(rejectEnValue("Only $269.99 with free shipping")).toMatch(/prix/);
    expect(rejectEnValue("<p>Now 64,99 $ shipped</p>")).toMatch(/prix/);
    expect(rejectEnValue("<p>Une chaise pour le salon et la cuisine avec des coussins.</p>")).toMatch(/français/);
  });
  it("does not flag size/inch notation as a price", () => {
    expect(rejectEnValue(`Carport 10 x 15 ft, 176.4" x 119.3" x 98.4"`)).toBeNull();
  });
});

describe("looksFrench", () => {
  it("needs a clear French majority, not one stray word", () => {
    expect(looksFrench("The chaise lounge is perfect for the patio and the pool.")).toBe(false);
    expect(looksFrench("Le fauteuil est parfait pour votre salon et la terrasse.")).toBe(true);
  });
});
