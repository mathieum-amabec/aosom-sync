import { describe, it, expect } from "vitest";
import { classifyCostway, KIND_PRODUCT_TYPE } from "@/lib/costway/taxonomy";

const DEHUM = "Appliances > Climate Control Appliances > Dehumidifiers";
const DRY = "Appliances > Washers & Dryers > Dryers";
const WASH = "Appliances > Washers & Dryers > Washing Machines";

describe("classifyCostway", () => {
  it("recognises dehumidifiers, washers and dryers from title + category", () => {
    expect(classifyCostway("60-Pint Dehumidifier for Home and Basements", DEHUM)).toBe("dehumidifier");
    expect(classifyCostway("Portable 7.7 lbs Automatic Laundry Washing Machine", WASH)).toBe("washer");
    expect(classifyCostway("1700W Electric Dryer Portable Tumble Dryer", DRY)).toBe("dryer");
  });
  it("sends washer+dryer combos to their own kind, but a twin-tub with a spin dryer is a washer", () => {
    expect(classifyCostway("Compact Washer and Dryer Laundry Combo for Apartments", DRY)).toBe("washer_dryer");
    expect(classifyCostway("20 lbs Compact Twin Tub Washing Machine with Spin Dryer", WASH)).toBe("washer");
    expect(classifyCostway("Full-Automatic Washing Machine Washer and Spin Dryer", WASH)).toBe("washer");
  });
  it("rejects what Costway mis-files (the 20 products found on 2026-10-03)", () => {
    expect(classifyCostway("25L Towel Warmer Bucket with 2 Temperature Settings", DRY)).toBeNull();
    expect(classifyCostway("20 L Large Blanket Towel Warmer for Bathroom", DRY)).toBeNull();
    expect(classifyCostway("5.5Gal Humidifier with 360° Nozzles and Wheels", DEHUM)).toBeNull();
    expect(classifyCostway("5.5L Cool Mist Humidifiers with Remote Control", DEHUM)).toBeNull();
  });
  it("keeps multi-product kits and furniture bundles out of the pilot", () => {
    expect(classifyCostway("Laundry Room Bundle: Wooden Cabinet Wall-Mounted Dryer", DRY)).toBeNull();
    expect(classifyCostway("Laundry Care Bundle with Washing Machine", WASH)).toBeNull();
  });
  it("returns null for anything else (never guesses)", () => {
    expect(classifyCostway("Ergonomic Mesh Computer Office Chair", "Furniture > Home Office")).toBeNull();
  });
  it("maps every kind to a product_type that the existing smart collections match", () => {
    expect(KIND_PRODUCT_TYPE.dehumidifier).toContain("Home Furnishings > Appliances"); // Électro & Tech
    expect(KIND_PRODUCT_TYPE.dehumidifier).toContain("Dehumidifier"); // Climatisation & Ventilation
    expect(KIND_PRODUCT_TYPE.washer).toContain("Washing Machines");
    expect(KIND_PRODUCT_TYPE.dryer).toContain("Clothes Dryers");
    expect(KIND_PRODUCT_TYPE.washer_dryer).toContain("Washer Dryer");
  });
});
