import { describe, it, expect, vi } from "vitest";

// content-generator imports "@/lib/config" at module load; mock it so the test
// doesn't require real env vars (the functions under test don't use config).
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-test", MAX_TOKENS_CONTENT: 1000 },
}));

const { slugify, clampMetaTitle, backfillSeoFields, stripSupplierBrands } = await import("@/lib/content-generator");
import type { GeneratedContent } from "@/lib/content-generator";

describe("stripSupplierBrands", () => {
  it("removes supplier brand tokens regardless of case", () => {
    // Brands become a space; the assertion normalizes whitespace since slugify
    // (the only caller) collapses gaps anyway. HOMCOM/HomCom and PawHut/Pawhut
    // collapse under the /i flag.
    const norm = (s: string) => stripSupplierBrands(s).replace(/\s+/g, " ").trim();
    expect(norm("Outsunny Chaise Longue")).toBe("Chaise Longue");
    expect(norm("HomCom desk")).toBe("desk");
    expect(norm("pawhut niche")).toBe("niche");
  });

  it("strips brands embedded in a kebab handle, leaving gaps for slugify to collapse", () => {
    expect(slugify(stripSupplierBrands("outsunny-chaise-longue-grise"))).toBe("chaise-longue-grise");
    expect(slugify(stripSupplierBrands("qaba-soozier-tapis"))).toBe("tapis");
  });

  it("leaves brand-free strings untouched", () => {
    expect(stripSupplierBrands("chaise-longue-grise")).toBe("chaise-longue-grise");
  });

  it("does not strip a brand name fused into a larger word (word-boundary guard)", () => {
    expect(stripSupplierBrands("qabardine")).toBe("qabardine");
  });
});

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
