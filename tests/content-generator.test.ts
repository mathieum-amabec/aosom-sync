import { describe, it, expect, vi } from "vitest";

// content-generator imports "@/lib/config" at module load; mock it so the test
// doesn't require real env vars (the functions under test don't use config).
vi.mock("@/lib/config", () => ({
  env: { anthropicApiKey: "test-key" },
  CLAUDE: { MODEL: "claude-test", MODEL_BATCH: "claude-test-batch", MAX_TOKENS_CONTENT: 1000 },
}));

// Mock the Anthropic SDK so generateProductContent runs without a network call.
// `create` is hoisted so each test sets the canned Claude response per case.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const {
  slugify, clampMetaTitle, backfillSeoFields, stripSupplierBrands, generateProductContent,
  inferDimensionsCm, collectCopyIssues,
} = await import("@/lib/content-generator");
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
          descriptionFr: "<p>Cette chaise pour votre jardin est confortable et pratique pour tous les jours.</p>",
          descriptionEn: "<p>en</p>",
          seoDescriptionFr: "desc fr",
          seoDescriptionEn: "desc en",
          metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
          metaTitleEn: "m en | Free Shipping — Furnish Direct",
          metaDescriptionFr: "md fr",
          metaDescriptionEn: "md en",
          urlHandleFr: "chaise-fr",
          urlHandleEn: "chair-en",
          tags: ["jardin","abri de jardin","garden shed","rangement outils","tool storage","outdoor storage","patio","remise"],
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

// Regression: stripSupplierBrands was only ever applied to titleFr/titleEn and the
// URL handles — never to descriptionFr/descriptionEn/seoDescription*, so a model
// that echoed the supplier name into the body (as the raw Aosom feed text often
// does) reached Shopify body_html untouched. Found during the 2026-09-15 catalog
// content investigation (532/1347 active products leaking a supplier name).
describe("generateProductContent — description brand stripping", () => {
  function claudeReturnsDescription(descriptionFr: string, descriptionEn = "<p>A chair.</p>") {
    create.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            titleFr: "Chaise longue grise",
            titleEn: "Grey lounge chair",
            descriptionFr,
            descriptionEn,
            seoDescriptionFr: "Chaise confortable pour votre jardin, avec des accoudoirs.",
            seoDescriptionEn: "desc en",
            metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
            metaTitleEn: "m en | Free Shipping — Furnish Direct",
            metaDescriptionFr: "md fr",
            metaDescriptionEn: "md en",
            urlHandleFr: "chaise-fr",
            urlHandleEn: "chair-en",
            tags: ["jardin","abri de jardin","garden shed","rangement outils","tool storage","outdoor storage","patio","remise"],
          }),
        },
      ],
    });
  }

  it("strips a supplier brand mentioned in the body of descriptionFr", async () => {
    claudeReturnsDescription(
      "<p>Cette chaise Outsunny est parfaite pour votre jardin, avec des accoudoirs confortables.</p>",
    );
    const out = await generateProductContent(makeProduct());
    expect(out.descriptionFr).not.toMatch(/outsunny/i);
    expect(out.descriptionFr).toContain("Cette chaise");
    expect(out.descriptionFr).toContain("accoudoirs");
  });

  it("handles a French elision directly attached to the brand without leaving a dangling apostrophe", async () => {
    claudeReturnsDescription(
      "<p>Profitez de l'Aosom chaise longue pour votre jardin, avec des accoudoirs confortables.</p>",
    );
    const out = await generateProductContent(makeProduct());
    expect(out.descriptionFr).not.toMatch(/aosom/i);
    expect(out.descriptionFr).not.toMatch(/\bl['’]\s/); // no orphaned "l' "
  });
});

// Write-time guard: descriptionFr must read as French. This is the backstop for
// the description-language class of bug (679/1382 active products served English
// body_html via a since-fixed diff-engine defect, CHANGELOG v0.5.92.3) — a bad
// generation must never reach Shopify silently.
describe("generateProductContent — French language guard", () => {
  it("escalates to the top-tier model when the batch model returns English descriptionFr", async () => {
    const englishResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            titleFr: "Chaise longue grise",
            titleEn: "Grey lounge chair",
            descriptionFr: "<p>This chair is great for your garden and easy to clean with a soft cloth.</p>",
            descriptionEn: "<p>This chair is great for your garden.</p>",
            seoDescriptionFr: "desc fr",
            seoDescriptionEn: "desc en",
            metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
            metaTitleEn: "m en | Free Shipping — Furnish Direct",
            metaDescriptionFr: "md fr",
            metaDescriptionEn: "md en",
            urlHandleFr: "chaise-fr",
            urlHandleEn: "chair-en",
            tags: ["jardin","abri de jardin","garden shed","rangement outils","tool storage","outdoor storage","patio","remise"],
          }),
        },
      ],
    };
    const frenchResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            titleFr: "Chaise longue grise",
            titleEn: "Grey lounge chair",
            descriptionFr: "<p>Cette chaise est parfaite pour votre jardin et facile à nettoyer.</p>",
            descriptionEn: "<p>This chair is great for your garden.</p>",
            seoDescriptionFr: "desc fr",
            seoDescriptionEn: "desc en",
            metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
            metaTitleEn: "m en | Free Shipping — Furnish Direct",
            metaDescriptionFr: "md fr",
            metaDescriptionEn: "md en",
            urlHandleFr: "chaise-fr",
            urlHandleEn: "chair-en",
            tags: ["jardin","abri de jardin","garden shed","rangement outils","tool storage","outdoor storage","patio","remise"],
          }),
        },
      ],
    };
    create.mockClear();
    create.mockResolvedValueOnce(englishResponse).mockResolvedValueOnce(frenchResponse);
    const out = await generateProductContent(makeProduct());
    expect(out.descriptionFr).toContain("parfaite pour votre jardin");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("throws when even the top-tier model's descriptionFr is not French", async () => {
    const englishResponse = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            titleFr: "Chaise longue grise",
            titleEn: "Grey lounge chair",
            descriptionFr: "<p>This chair is great for your garden and easy to clean with a soft cloth.</p>",
            descriptionEn: "<p>This chair is great for your garden.</p>",
            seoDescriptionFr: "desc fr",
            seoDescriptionEn: "desc en",
            metaTitleFr: "m fr | Livraison gratuite — Ameublo Direct",
            metaTitleEn: "m en | Free Shipping — Furnish Direct",
            metaDescriptionFr: "md fr",
            metaDescriptionEn: "md en",
            urlHandleFr: "chaise-fr",
            urlHandleEn: "chair-en",
            tags: ["jardin","abri de jardin","garden shed","rangement outils","tool storage","outdoor storage","patio","remise"],
          }),
        },
      ],
    };
    create.mockResolvedValue(englishResponse); // both tiers return the same bad content
    await expect(generateProductContent(makeProduct())).rejects.toThrow();
  });
});

describe("generateProductContent — tags never carry a supplier name", () => {
  it("strips a brand out of a tag and drops a tag that was only the brand", async () => {
    create.mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          titleFr: "Chaise longue", titleEn: "Lounge chair",
          descriptionFr: "<p>Cette chaise pour votre jardin est confortable et pratique pour tous les jours.</p>",
          descriptionEn: "<p>en</p>", seoDescriptionFr: "d", seoDescriptionEn: "d",
          metaTitleFr: "m | Livraison gratuite — Ameublo Direct", metaTitleEn: "m | Free Shipping — Furnish Direct",
          metaDescriptionFr: "md", metaDescriptionEn: "md", urlHandleFr: "chaise", urlHandleEn: "chair",
          tags: ["costway chaise", "outsunny", "bureau", "a", "b", "c", "d", "e"],
        }),
      }],
    });
    const out = await generateProductContent(makeProduct());
    expect(out.tags).toContain("chaise");
    expect(out.tags).toContain("bureau");
    expect(out.tags).not.toContain("outsunny");
    expect(out.tags.join(" ").toLowerCase()).not.toMatch(/costway|outsunny/);
  });
});

// Regression (2026-10-04): a batch of newly-imported "coffres de rangement extérieur" came
// out with no physical dimensions in the description at all, and inconsistent capacity units
// (some litres, some gallons, some both) — a shopper has no reliable way to judge size. Root
// cause: product.dimensions was never passed into the prompt, and the capacity unit was never
// constrained. See inferDimensionsCm's own doc comment for why Aosom's raw Length/Width/Height
// columns need a heuristic at all (they are not unit-consistent row to row).
describe("inferDimensionsCm", () => {
  it("converts to cm when the max axis is a plausible inch value (<=120)", () => {
    // Real row: D2-0014 "62'' L 2-Story Rabbit Hutch" — the feed's 62.3 IS inches.
    expect(inferDimensionsCm({ length: 62.3, width: 22.8, height: 26.8 })).toEqual({
      length: 158.2, width: 57.9, height: 68.1,
    });
  });

  it("leaves the triple unconverted when the max axis is already implausible as inches (>120)", () => {
    // Real row: 845-209V01BN "30" x 21" x 71" Garden Storage Shed" — the feed's 179 is
    // already cm (179cm ≈ 71in matches the title; as raw inches it would be 14.9 FEET tall).
    expect(inferDimensionsCm({ length: 77, width: 54.2, height: 179 })).toEqual({
      length: 77, width: 54.2, height: 179,
    });
  });

  it("returns null when any axis is zero or missing (never fabricate a size)", () => {
    expect(inferDimensionsCm({ length: 0, width: 10, height: 10 })).toBeNull();
    expect(inferDimensionsCm(undefined)).toBeNull();
  });
});

describe("collectCopyIssues — dimensions & capacity consistency", () => {
  const base: GeneratedContent = {
    titleFr: "Coffre de rangement", titleEn: "Storage box",
    descriptionFr: "<p>Un coffre robuste pour votre jardin, facile à nettoyer et étanche.</p>",
    descriptionEn: "<p>A sturdy box for your garden.</p>",
    seoDescriptionFr: "Coffre de rangement étanche pour jardin.", seoDescriptionEn: "Waterproof garden storage box.",
    metaTitleFr: "m | Livraison gratuite — Ameublo Direct", metaTitleEn: "m | Free Shipping — Furnish Direct",
    metaDescriptionFr: "md", metaDescriptionEn: "md", urlHandleFr: "coffre", urlHandleEn: "box",
    tags: ["jardin","coffre","rangement","storage","patio","outdoor","etanche","waterproof"],
    brand: "Outsunny",
  };

  it("flags a description that never mentions dimensions that WERE provided", () => {
    const issues = collectCopyIssues(base, { length: 127, width: 55.9, height: 59.9 });
    expect(issues.some((i) => /dimensions/i.test(i))).toBe(true);
  });

  it("does not flag anything when the description states the provided dimensions", () => {
    const withDims: GeneratedContent = {
      ...base,
      descriptionFr: base.descriptionFr + " Dimensions : 127 x 55.9 x 59.9 cm (50 x 22 x 23.6 po).",
      descriptionEn: base.descriptionEn + " Dimensions: 127 x 55.9 x 59.9 cm (50 x 22 x 23.6 in).",
    };
    const issues = collectCopyIssues(withDims, { length: 127, width: 55.9, height: 59.9 });
    expect(issues.some((i) => /dimensions/i.test(i))).toBe(false);
  });

  it("does not require dimensions when none were provided (expectedDimsCm omitted)", () => {
    expect(collectCopyIssues(base).some((i) => /dimensions/i.test(i))).toBe(false);
    expect(collectCopyIssues(base, null).some((i) => /dimensions/i.test(i))).toBe(false);
  });

  it("flags \"gallon\" anywhere in the body, even alongside a litre figure", () => {
    const withGallons: GeneratedContent = {
      ...base,
      descriptionEn: base.descriptionEn + " Offers 283 litres (75 gallons) of storage.",
    };
    const issues = collectCopyIssues(withGallons);
    expect(issues.some((i) => /gallon/i.test(i))).toBe(true);
  });

  it("does not flag a description that states capacity in litres only", () => {
    const litresOnly: GeneratedContent = { ...base, descriptionEn: base.descriptionEn + " Offers 283 litres of storage." };
    expect(collectCopyIssues(litresOnly).some((i) => /gallon/i.test(i))).toBe(false);
  });
});

describe("generateProductContent — dimensions reach the prompt and the final copy", () => {
  function makeProductWithDims(dims: { length: number; width: number; height: number }) {
    return {
      name: "Coffre de rangement",
      description: "<p>Un coffre.</p>",
      shortDescription: "<p>Court.</p>",
      brand: "Outsunny",
      productType: "Patio & Garden > Patio Furniture > Deck Box & Outdoor Storage",
      material: "Résine",
      variants: [{ sku: "84B-458GY", price: 199, dimensions: dims }],
    } as never;
  }

  it("sends a computed cm Dimensions line to Claude when the source variant has real dimensions", async () => {
    create.mockClear();
    claudeReturns("Coffre de rangement extérieur", "Outdoor storage box");
    await generateProductContent(makeProductWithDims({ length: 50, width: 22, height: 23.6 }));
    const sentPrompt = create.mock.calls[0][0].messages[0].content as string;
    expect(sentPrompt).toContain("Dimensions: 127 x 55.9 x 59.9 cm");
  });

  it("tells the model not to invent dimensions when the source has none", async () => {
    create.mockClear();
    claudeReturns("Coffre de rangement extérieur", "Outdoor storage box");
    await generateProductContent(makeProductWithDims({ length: 0, width: 0, height: 0 }));
    const sentPrompt = create.mock.calls[0][0].messages[0].content as string;
    expect(sentPrompt).toContain("not provided by the supplier — do not invent");
  });

  it("retries once on the same tier when the model drops the provided dimensions, and keeps the retry's copy", async () => {
    const missingDims = {
      content: [{
        type: "text",
        text: JSON.stringify({
          titleFr: "Coffre de rangement extérieur", titleEn: "Outdoor storage box",
          descriptionFr: "<p>Ce coffre robuste protège vos outils de jardin des intempéries.</p>",
          descriptionEn: "<p>This sturdy box protects your garden tools from the weather.</p>",
          seoDescriptionFr: "Coffre de rangement étanche pour jardin.", seoDescriptionEn: "Waterproof garden storage box.",
          metaTitleFr: "m | Livraison gratuite — Ameublo Direct", metaTitleEn: "m | Free Shipping — Furnish Direct",
          metaDescriptionFr: "md", metaDescriptionEn: "md", urlHandleFr: "coffre", urlHandleEn: "box",
          tags: ["jardin","coffre","rangement","storage","patio","outdoor","etanche","waterproof"],
        }),
      }],
    };
    const withDims = {
      content: [{
        type: "text",
        text: JSON.stringify({
          titleFr: "Coffre de rangement extérieur", titleEn: "Outdoor storage box",
          descriptionFr: "<p>Ce coffre robuste protège vos outils de jardin des intempéries. Dimensions : 127 x 55.9 x 59.9 cm.</p>",
          descriptionEn: "<p>This sturdy box protects your garden tools from the weather. Dimensions: 127 x 55.9 x 59.9 cm.</p>",
          seoDescriptionFr: "Coffre de rangement étanche pour jardin.", seoDescriptionEn: "Waterproof garden storage box.",
          metaTitleFr: "m | Livraison gratuite — Ameublo Direct", metaTitleEn: "m | Free Shipping — Furnish Direct",
          metaDescriptionFr: "md", metaDescriptionEn: "md", urlHandleFr: "coffre", urlHandleEn: "box",
          tags: ["jardin","coffre","rangement","storage","patio","outdoor","etanche","waterproof"],
        }),
      }],
    };
    create.mockClear();
    create.mockResolvedValueOnce(missingDims).mockResolvedValueOnce(withDims);
    const out = await generateProductContent(makeProductWithDims({ length: 50, width: 22, height: 23.6 }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.descriptionFr).toContain("127 x 55.9 x 59.9 cm");
    // The retry call is still on the SAME (first) tier, not an escalation to the stronger model.
    expect(create.mock.calls[1][0].model).toBe(create.mock.calls[0][0].model);
  });
});
