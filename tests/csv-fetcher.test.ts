import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { parseTsv } from "@/lib/csv-fetcher";

const FIXTURE = readFileSync(
  path.join(__dirname, "fixtures/sample.csv"),
  "utf-8"
);

describe("CSV Parser", () => {
  it("parses the CSV fixture into products", () => {
    const products = parseTsv(FIXTURE);
    expect(products.length).toBeGreaterThan(0);
  });

  it("extracts all required fields from first product", () => {
    const products = parseTsv(FIXTURE);
    const first = products[0];

    expect(first.sku).toBeTruthy();
    expect(first.name).toBeTruthy();
    expect(typeof first.price).toBe("number");
    expect(first.price).toBeGreaterThan(0);
    expect(typeof first.qty).toBe("number");
    expect(first.productType).toBeTruthy();
    expect(first.images.length).toBeGreaterThan(0);
  });

  it("replaces [BRAND NAME] in descriptions", () => {
    const products = parseTsv(FIXTURE);
    for (const p of products) {
      expect(p.description).not.toContain("[BRAND NAME]");
      expect(p.shortDescription).not.toContain("[BRAND NAME]");
    }
  });

  it("collects images from Image, Images, and Image1-7 fields", () => {
    const products = parseTsv(FIXTURE);
    const withImages = products.filter((p) => p.images.length > 1);
    expect(withImages.length).toBeGreaterThan(0);
    // No duplicate images
    for (const p of withImages) {
      const unique = new Set(p.images);
      expect(unique.size).toBe(p.images.length);
    }
  });

  it("extracts brand from product name", () => {
    const products = parseTsv(FIXTURE);
    for (const p of products) {
      expect(p.brand).toBeTruthy();
    }
  });

  it("handles empty/missing fields gracefully", () => {
    const csv = `"SKU","Image","Name","Price","custom_tagid","Category","Qty","color","size","short_description","Images","description","Gtin","Weight","Length","Width","Height","Psin","Product_Type","Sin","Estimated Arrival Time","Out Of Stock Expected","pdf","Material","Package_Num","Image1","Image2","Image3","Image4","Image5","Image6","Image7","Box_Size","Box_Weight","Video"
TEST-001,,"Test Product",99.99,,,5,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const products = parseTsv(csv);
    expect(products).toHaveLength(1);
    expect(products[0].sku).toBe("TEST-001");
    expect(products[0].price).toBe(99.99);
    expect(products[0].qty).toBe(5);
    expect(products[0].images).toHaveLength(0);
  });

  it("skips rows with empty SKU", () => {
    const csv = `"SKU","Image","Name","Price","custom_tagid","Category","Qty","color","size","short_description","Images","description","Gtin","Weight","Length","Width","Height","Psin","Product_Type","Sin","Estimated Arrival Time","Out Of Stock Expected","pdf","Material","Package_Num","Image1","Image2","Image3","Image4","Image5","Image6","Image7","Box_Size","Box_Weight","Video"
,,"No SKU",10,,,,,,,,,,,,,,,,,,,,,,,,,,,,`;
    const products = parseTsv(csv);
    expect(products).toHaveLength(0);
  });
});
