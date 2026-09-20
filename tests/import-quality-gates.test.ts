/**
 * Shared quality gates (image / French / brand-leak) used by importToShopify's
 * pre-publish check and post-publish safety net (import-pipeline.ts). All three
 * checks reuse existing, already-tested mechanisms — this file only tests that
 * runQualityGates wires them together correctly (which outcome fails which gate,
 * and that all three failures can be reported at once).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/image-compliance-audit", () => ({
  enforceCleanPrimaryImage: vi.fn(),
}));

import { runQualityGates } from "@/lib/import-quality-gates";
import { enforceCleanPrimaryImage } from "@/lib/image-compliance-audit";

const FR_CONTENT = {
  titleFr: "Chaise longue de patio",
  descriptionFr:
    "Profitez de votre jardin avec cette chaise longue confortable, conçue pour durer et facile à installer. " +
    "Idéale pour votre terrasse, cette pièce est fabriquée avec des matériaux résistants aux intempéries.",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enforceCleanPrimaryImage).mockResolvedValue({
    images: ["https://cdn/a.jpg"],
    outcome: "clean",
    calls: 1,
  } as never);
});

describe("runQualityGates — image gate", () => {
  it("passes when the image guard reports clean", async () => {
    const result = await runQualityGates(["https://cdn/a.jpg"], FR_CONTENT);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes when the image guard reordered a clean alternative to pos-1", async () => {
    vi.mocked(enforceCleanPrimaryImage).mockResolvedValue({
      images: ["https://cdn/b.jpg", "https://cdn/a.jpg"],
      outcome: "reordered",
      promotedFrom: 1,
      calls: 2,
    } as never);

    expect((await runQualityGates(["https://cdn/a.jpg", "https://cdn/b.jpg"], FR_CONTENT)).passed).toBe(true);
  });

  it("passes when no verdict could be obtained (no evidence is not evidence of a problem)", async () => {
    vi.mocked(enforceCleanPrimaryImage).mockResolvedValue({
      images: ["https://cdn/a.jpg"],
      outcome: "skipped",
      calls: 0,
    } as never);

    expect((await runQualityGates(["https://cdn/a.jpg"], FR_CONTENT)).passed).toBe(true);
  });

  it("fails with image_not_clean when pos-1 has an overlay and no clean alternative exists", async () => {
    vi.mocked(enforceCleanPrimaryImage).mockResolvedValue({
      images: ["https://cdn/a.jpg"],
      outcome: "no_alternative",
      calls: 3,
    } as never);

    const result = await runQualityGates(["https://cdn/a.jpg"], FR_CONTENT);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["image_not_clean"]);
  });
});

describe("runQualityGates — French gate (detectDescriptionLanguage)", () => {
  it("passes genuine French copy", async () => {
    expect((await runQualityGates(["x"], FR_CONTENT)).passed).toBe(true);
  });

  it("fails when the description is actually English", async () => {
    const result = await runQualityGates(["x"], {
      titleFr: "Patio lounge chair",
      descriptionFr:
        "Enjoy your garden with this comfortable lounge chair, designed to last and easy to " +
        "install. This piece features weather-resistant materials for your patio.",
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("not_french");
  });

  it("fails on an empty description", async () => {
    const result = await runQualityGates(["x"], { titleFr: "x", descriptionFr: "" });
    expect(result.failures).toContain("not_french");
  });
});

describe("runQualityGates — brand-leak gate (forbiddenBrandsIn)", () => {
  it("fails when a forbidden supplier brand appears in the title", async () => {
    const result = await runQualityGates(["x"], { ...FR_CONTENT, titleFr: "Chaise Outsunny de patio" });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("brand_leak");
  });

  it("fails when a forbidden supplier brand appears in the description", async () => {
    const result = await runQualityGates(["x"], {
      ...FR_CONTENT,
      descriptionFr: FR_CONTENT.descriptionFr + " Fabriqué par Aosom.",
    });
    expect(result.failures).toContain("brand_leak");
  });

  it("does not flag a brand name that is not on the forbidden list", async () => {
    const result = await runQualityGates(["x"], {
      ...FR_CONTENT,
      descriptionFr: FR_CONTENT.descriptionFr + " Idéal pour votre marque IKEA.",
    });
    expect(result.failures).not.toContain("brand_leak");
  });
});

describe("runQualityGates — multiple simultaneous failures", () => {
  it("reports every failing gate, not just the first", async () => {
    vi.mocked(enforceCleanPrimaryImage).mockResolvedValue({
      images: ["https://cdn/a.jpg"],
      outcome: "no_alternative",
      calls: 3,
    } as never);

    const result = await runQualityGates(["https://cdn/a.jpg"], {
      titleFr: "Outsunny patio chair",
      descriptionFr: "Enjoy your garden with this Outsunny lounge chair, easy to install.",
    });

    expect(result.passed).toBe(false);
    expect(result.failures.sort()).toEqual(["brand_leak", "image_not_clean", "not_french"].sort());
  });
});
