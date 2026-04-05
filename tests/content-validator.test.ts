import { describe, it, expect } from "vitest";
import { validateContent } from "@/lib/content-generator";

const validPayload = {
  titleFr: "Table de jardin",
  titleEn: "Garden Table",
  descriptionFr: "Une belle table",
  descriptionEn: "A beautiful table",
  seoDescriptionFr: "Achetez cette table",
  seoDescriptionEn: "Buy this table",
  tags: ["outdoor", "garden"],
};

describe("validateContent", () => {
  it("accepts a valid payload", () => {
    const result = validateContent(validPayload);
    expect(result.titleFr).toBe("Table de jardin");
    expect(result.tags).toEqual(["outdoor", "garden"]);
  });

  it("throws on null input", () => {
    expect(() => validateContent(null)).toThrow("non-object");
  });

  it("throws on undefined input", () => {
    expect(() => validateContent(undefined)).toThrow("non-object");
  });

  it("throws on string input", () => {
    expect(() => validateContent("hello")).toThrow("non-object");
  });

  it("throws on number input", () => {
    expect(() => validateContent(42)).toThrow("non-object");
  });

  it("throws when titleFr is missing", () => {
    const { titleFr, ...rest } = validPayload;
    expect(() => validateContent(rest)).toThrow("titleFr");
  });

  it("throws when titleEn is missing", () => {
    const { titleEn, ...rest } = validPayload;
    expect(() => validateContent(rest)).toThrow("titleEn");
  });

  it("throws when descriptionFr is missing", () => {
    const { descriptionFr, ...rest } = validPayload;
    expect(() => validateContent(rest)).toThrow("descriptionFr");
  });

  it("throws when seoDescriptionEn is missing", () => {
    const { seoDescriptionEn, ...rest } = validPayload;
    expect(() => validateContent(rest)).toThrow("seoDescriptionEn");
  });

  it("throws when tags is missing", () => {
    const { tags, ...rest } = validPayload;
    expect(() => validateContent(rest)).toThrow("tags");
  });

  it("throws when a string field is a number", () => {
    expect(() => validateContent({ ...validPayload, titleFr: 42 })).toThrow("titleFr");
    expect(() => validateContent({ ...validPayload, titleFr: 42 })).toThrow("string");
  });

  it("throws when a string field is null", () => {
    expect(() => validateContent({ ...validPayload, descriptionEn: null })).toThrow("descriptionEn");
  });

  it("throws when tags is not an array", () => {
    expect(() => validateContent({ ...validPayload, tags: "wrong" })).toThrow("tags must be an array");
  });

  it("throws when tags is an object", () => {
    expect(() => validateContent({ ...validPayload, tags: {} })).toThrow("tags must be an array");
  });

  it("accepts empty tags array", () => {
    const result = validateContent({ ...validPayload, tags: [] });
    expect(result.tags).toEqual([]);
  });

  it("passes through extra fields without error", () => {
    const result = validateContent({ ...validPayload, extraField: "bonus" });
    expect(result.titleFr).toBe("Table de jardin");
  });
});
