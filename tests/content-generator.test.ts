import { describe, it, expect, vi } from "vitest";

// content-generator imports "@/lib/config" at module load; mock it so the test
// doesn't require real env vars (the functions under test don't use config).
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-test", MAX_TOKENS_CONTENT: 1000 },
}));

// Mock the Anthropic SDK so generateProductContent runs without a network call.
// `create` is hoisted so each test sets the canned Claude response per case.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const { slugify, clampMetaTitle, backfillSeoFields, generateProductContent } = await import(
  "@/lib/content-generator"
);
import type { GeneratedContent } from "@/lib/content-generator";

describe("slugify", () => {
  it("strips accents, lowercases, and hyphenates", () => {
    expect(slugify("Chaise Longue Réglable Grise")).toBe("chaise-longue-reglable-grise");
  });

  it("returns empty string for all-symbol / non-Latin input", () => {
    expect(slugify("!!! ™ ®")).toBe("");
    expect(slugify("机の上")).toBe("");
  });

  it("caps length at 100 chars", () => {
    expect(slugify("a".repeat(200)).length).toBe(100);
  });
});

describe("clampMetaTitle", () => {
  it("leaves a short title untouched", () => {
    const t = "Tabouret de bar | Livraison gratuite — Ameublo Direct";
    expect(clampMetaTitle(t, 65)).toBe(t);
  });

  it("trims the name part at a word boundary but keeps the full brand suffix", () => {
    const t =
      "Chaise longue de jardin inclinable extra large robuste | Livraison gratuite — Ameublo Direct";
    const out = clampMetaTitle(t, 65);
    expect(out.length).toBeLessThanOrEqual(65);
    expect(out.endsWith(" | Livraison gratuite — Ameublo Direct")).toBe(true);
  });

  it("falls back to a plain slice when there is no ' | ' separator", () => {
    const t = "x".repeat(80);
    expect(clampMetaTitle(t, 65)).toBe("x".repeat(65));
  });
});

// A stale import job (generated before product-naming-v2) lacks the SEO-native
// fields. JSON.parse yields an object missing them, typed as GeneratedContent.
function staleContent(): GeneratedContent {
  return {
    titleFr: "Chaise longue grise",
    titleEn: "Grey lounge chair",
    descriptionFr: "<p>fr</p>",
    descriptionEn: "<p>en</p>",
    seoDescriptionFr: "Chaise longue grise confortable pour le jardin.",
    seoDescriptionEn: "Comfortable grey lounge chair for the garden.",
    tags: ["jardin"],
    // metaTitle*/metaDescription*/urlHandle*/brand intentionally absent
  } as unknown as GeneratedContent;
}

describe("backfillSeoFields", () => {
  it("fills every missing SEO field with a safe, non-empty default", () => {
    const out = backfillSeoFields(staleContent(), "Outsunny");

    expect(out.brand).toBe("Outsunny");
    expect(out.urlHandleFr).toBe("chaise-longue-grise");
    expect(out.urlHandleEn).toBe("grey-lounge-chair");
    expect(out.metaTitleFr).toContain("Ameublo Direct");
    expect(out.metaTitleEn).toContain("Furnish Direct");
    expect(out.metaTitleFr.length).toBeLessThanOrEqual(65);
    expect(out.metaDescriptionFr).toBe("Chaise longue grise confortable pour le jardin.");
    // No field is left empty — this is what prevents the Shopify 422.
    for (const v of [
      out.metaTitleFr, out.metaTitleEn, out.metaDescriptionFr,
      out.metaDescriptionEn, out.urlHandleFr, out.urlHandleEn, out.brand,
    ]) {
      expect(v.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not clobber fields the model already produced", () => {
    const full = { ...staleContent(), metaTitleFr: "Already set | x", urlHandleFr: "custom-handle", brand: "HOMCOM" } as GeneratedContent;
    const out = backfillSeoFields(full, "Outsunny");
    expect(out.metaTitleFr).toBe("Already set | x");
    expect(out.urlHandleFr).toBe("custom-handle");
    expect(out.brand).toBe("HOMCOM"); // existing brand wins over the fallback arg
  });
});

// Regression: brand-sanitize — supplier brand names leaked into generated titles
// Found by /qa on 2026-06-18
// The model is told never to put the supplier brand in the title, but it
// sometimes does anyway. generateProductContent must strip them programmatically.
function makeProduct() {
  return {
    name: "Chaise longue grise",
    description: "<p>Une chaise.</p>",
    shortDescription: "<p>Court.</p>",
    brand: "Outsunny",
    productType: "Chaise",
    material: "Acier",
    variants: [{ sku: "ABC-GY", price: 99 }],
  } as never;
}

function claudeReturns(titleFr: string, titleEn: string) {
  create.mockResolvedValue({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          titleFr,
          titleEn,
          descriptionFr: "<p>fr</p>",
          descriptionEn: "<p>en</p>",
          seoDescriptionFr: "desc fr",
          seoDescriptionEn: "desc en",
          metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
          metaTitleEn: "m en | Free Shipping — Furnish Direct",
          metaDescriptionFr: "md fr",
          metaDescriptionEn: "md en",
          urlHandleFr: "chaise-fr",
          urlHandleEn: "chair-en",
          tags: ["jardin"],
        }),
      },
    ],
  });
}

describe("generateProductContent — supplier brand stripping", () => {
  it("strips a leading supplier brand from titleFr and titleEn", async () => {
    claudeReturns("Outsunny Chaise longue grise", "HOMCOM Grey lounge chair");
    const out = await generateProductContent(makeProduct());
    expect(out.titleFr).toBe("Chaise longue grise");
    expect(out.titleEn).toBe("Grey lounge chair");
  });

  it("strips brands case-insensitively and from the middle of the title", async () => {
    claudeReturns("Chaise pliante PawHut grise", "Folding chair by aosom grey");
    const out = await generateProductContent(makeProduct());
    expect(out.titleFr).toBe("Chaise pliante grise");
    expect(out.titleEn).toBe("Folding chair by grey");
    expect(out.titleFr).not.toMatch(/pawhut/i);
    expect(out.titleEn).not.toMatch(/aosom/i);
  });

  it("strips multiple brands in one title and leaves clean titles untouched", async () => {
    claudeReturns("Vinsetto Soozier Bureau", "Clean Office Desk");
    const out = await generateProductContent(makeProduct());
    expect(out.titleFr).toBe("Bureau");
    expect(out.titleEn).toBe("Clean Office Desk"); // no brand, unchanged
  });
});
