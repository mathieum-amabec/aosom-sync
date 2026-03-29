import { describe, it, expect } from "vitest";
import {
  parseSku,
  stripColorFromTitle,
  mergeVariants,
  COLOR_MAP,
} from "@/lib/variant-merger";
import type { AosomProduct } from "@/types/aosom";

describe("parseSku", () => {
  it("extracts color from known 2-letter suffix", () => {
    const result = parseSku("842-121V80BK");
    expect(result.base).toBe("842-121V80");
    expect(result.colorCode).toBe("BK");
    expect(result.color).toBe("Noir");
  });

  it("returns null color for unknown suffix", () => {
    const result = parseSku("842-121V80");
    expect(result.base).toBe("842-121V80");
    expect(result.colorCode).toBeNull();
    expect(result.color).toBeNull();
  });

  it("requires base length >= 3", () => {
    const result = parseSku("AABK"); // length 4, base would be "AA" (2 chars)
    expect(result.colorCode).toBeNull();
  });

  it("handles all COLOR_MAP entries", () => {
    for (const [code, name] of Object.entries(COLOR_MAP)) {
      const result = parseSku(`TESTSKU${code}`);
      expect(result.colorCode).toBe(code);
      expect(result.color).toBe(name);
    }
  });
});

describe("stripColorFromTitle", () => {
  it("strips trailing French color", () => {
    expect(stripColorFromTitle("Chaise pliante - Noir")).toBe("Chaise pliante");
    expect(stripColorFromTitle("Table, Gris")).toBe("Table");
  });

  it("strips trailing English color", () => {
    expect(stripColorFromTitle("Folding Chair - Black")).toBe("Folding Chair");
    expect(stripColorFromTitle("Table, Grey")).toBe("Table");
  });

  it("preserves title without color", () => {
    expect(stripColorFromTitle("Gazebo 10x12")).toBe("Gazebo 10x12");
  });

  it("strips with dash separator", () => {
    expect(stripColorFromTitle("Product – Bleu")).toBe("Product");
  });
});

describe("mergeVariants", () => {
  function makeProduct(overrides: Partial<AosomProduct> = {}): AosomProduct {
    return {
      sku: "TEST-001",
      name: "Test Product",
      price: 99.99,
      qty: 10,
      color: "Black",
      size: "",
      shortDescription: "",
      description: "",
      images: ["https://example.com/img.jpg"],
      gtin: "",
      weight: 5,
      dimensions: { length: 10, width: 10, height: 10 },
      productType: "Test > Category",
      category: "Test",
      brand: "TestBrand",
      material: "Metal",
      psin: "PSIN001",
      sin: "",
      video: "",
      estimatedArrival: "",
      outOfStockExpected: "",
      packageNum: "",
      boxSize: "",
      boxWeight: "",
      pdf: "",
      ...overrides,
    };
  }

  it("groups products by PSIN", () => {
    const products = [
      makeProduct({ sku: "TEST-001BK", psin: "GROUP1", color: "Black" }),
      makeProduct({ sku: "TEST-001GY", psin: "GROUP1", color: "Grey" }),
      makeProduct({ sku: "OTHER-001", psin: "GROUP2", color: "Blue" }),
    ];
    const merged = mergeVariants(products);
    expect(merged).toHaveLength(2);
    const group1 = merged.find((m) => m.groupKey === "GROUP1");
    expect(group1?.variants).toHaveLength(2);
  });

  it("falls back to parseSku when PSIN is empty", () => {
    const products = [
      makeProduct({ sku: "842-001BK", psin: "", color: "Black" }),
      makeProduct({ sku: "842-001GY", psin: "", color: "Grey" }),
    ];
    const merged = mergeVariants(products);
    expect(merged).toHaveLength(1);
    expect(merged[0].variants).toHaveLength(2);
    expect(merged[0].groupKey).toBe("842-001");
  });

  it("assigns French color names from COLOR_MAP", () => {
    const products = [
      makeProduct({ sku: "TEST-001BK", psin: "G1" }),
      makeProduct({ sku: "TEST-001GY", psin: "G1" }),
    ];
    const merged = mergeVariants(products);
    expect(merged[0].variants[0].color).toBe("Noir");
    expect(merged[0].variants[1].color).toBe("Gris");
  });

  it("strips color from merged product name", () => {
    const products = [
      makeProduct({ sku: "A-BK", name: "Chair - Black", psin: "G1" }),
      makeProduct({ sku: "A-GY", name: "Chair - Grey", psin: "G1" }),
    ];
    const merged = mergeVariants(products);
    expect(merged[0].name).toBe("Chair");
  });

  it("deduplicates images across variants", () => {
    const products = [
      makeProduct({
        sku: "A-BK",
        psin: "G1",
        images: ["https://a.com/1.jpg", "https://a.com/2.jpg"],
      }),
      makeProduct({
        sku: "A-GY",
        psin: "G1",
        images: ["https://a.com/2.jpg", "https://a.com/3.jpg"],
      }),
    ];
    const merged = mergeVariants(products);
    expect(merged[0].images).toHaveLength(3);
  });
});
