import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/content-generator", () => ({ getAnthropicClient: vi.fn(() => ({})) }));
vi.mock("@/lib/llm-budget", () => ({ budgetedCreate: vi.fn() }));

import {
  buildJudgePrompt,
  checkContentStructure,
  analyzeGallery,
  cleanGallery,
  checkTitle,
  checkColorPhotos,
  checkShopifySummary,
  checkStorefrontHtml,
  judgeContent,
  unsupportedClaims,
  type LlmText,
} from "@/lib/auto-import/verify";
import type { AosomMergedProduct } from "@/types/aosom";
import type { GeneratedContent } from "@/lib/content-generator";

const product: AosomMergedProduct = {
  groupKey: "g1", name: "Cat Tree 71 inch Multi-Level with Scratching Posts", brand: "PawHut", productType: "Pet Supplies > Cats",
  category: "", description: "<p>Height 71 inches (180 cm). Weight capacity 22 lbs. Includes 3 platforms and 2 posts. Four levels.</p>",
  shortDescription: "", material: "Particle board, sisal", images: ["a", "b", "c", "d"], video: "", pdf: "",
  variants: [{
    sku: "D30-1", price: 78.99, qty: 50, color: "Gris", size: "", gtin: "", weight: 12, dimensions: { length: 50, width: 40, height: 180 },
    images: [], estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "",
  }],
};

const FR_DESC =
  "<p>Cet arbre à chat de 180 cm offre un espace de jeu et de repos pour votre compagnon. Il comprend plusieurs plateformes et des poteaux à griffer recouverts de sisal.</p>" +
  "<ul><li>Hauteur de 180 cm pour grimper en toute sécurité</li><li>3 plateformes et 2 poteaux à griffer</li><li>Structure stable, facile à assembler à la maison</li></ul>" +
  "<p>Un meuble pratique et solide, conçu pour durer dans votre salon et pour le plaisir de votre chat tous les jours.</p>";

const good: GeneratedContent = {
  titleFr: "Arbre à chat multiniveau de 180 cm avec poteaux à griffer",
  titleEn: "Multi-level cat tree 180 cm with scratching posts",
  descriptionFr: FR_DESC,
  descriptionEn: "<p>This 180 cm cat tree offers a play and rest space for your pet. It includes 3 platforms and 2 scratching posts covered in sisal for hours of fun.</p><ul><li>180 cm tall</li><li>Stable and easy to assemble</li></ul>",
  seoDescriptionFr: "x", seoDescriptionEn: "x",
  metaTitleFr: "Arbre à chat 180 cm | Ameublo Direct", metaTitleEn: "Cat tree 180 cm | Furnish Direct",
  metaDescriptionFr: "Arbre à chat multiniveau de 180 cm avec poteaux à griffer. Livraison gratuite au Canada.", metaDescriptionEn: "x",
  urlHandleFr: "arbre-a-chat-multiniveau-180-cm", urlHandleEn: "cat-tree-180", tags: ["chat", "arbre-a-chat"], brand: "PawHut",
};

describe("layer 1 — structure and facts", () => {
  it("passes clean copy", () => {
    expect(checkContentStructure(product, good)).toEqual({ ok: true, reasons: [] });
  });

  it("accepts a measurement converted from the supplier's inches", () => {
    expect(unsupportedClaims("Hauteur 180 cm, capacité 10 kg", product)).toEqual([]);
  });

  it("rejects a measurement the supplier data cannot explain", () => {
    expect(unsupportedClaims("Hauteur 250 cm", product)).toEqual(["250 cm"]);
    const bad = { ...good, descriptionFr: good.descriptionFr.replace("180 cm pour", "250 cm pour") };
    expect(checkContentStructure(product, bad).reasons.join()).toContain("unsupported_numbers");
  });

  it("flags template leftovers, English units, prices, unsafe or broken HTML, supplier brands", () => {
    const cases: Array<[Partial<GeneratedContent>, string]> = [
      [{ descriptionFr: good.descriptionFr + "<p>[BRAND NAME]</p>" }, "template_leftover"],
      [{ descriptionFr: good.descriptionFr + "<p>Hauteur 71 inches.</p>" }, "english_units_in_french_copy"],
      [{ descriptionFr: good.descriptionFr + "<p>Seulement 49,99 $</p>" }, "price_in_copy"],
      [{ descriptionFr: good.descriptionFr + "<script>x</script>" }, "unsafe_html"],
      [{ descriptionFr: good.descriptionFr + "<ul><li>oups</ul>" }, "unbalanced_html"],
      [{ descriptionFr: good.descriptionFr + "<p>Une qualité PawHut garantie pour votre chat.</p>" }, "supplier_brand"],
    ];
    for (const [patch, expected] of cases) {
      const v = checkContentStructure(product, { ...good, ...patch });
      expect(v.ok, expected).toBe(false);
      expect(v.reasons.join(), expected).toContain(expected);
    }
  });

  it("flags missing fields, short copy and English passed off as French", () => {
    expect(checkContentStructure(product, { ...good, titleFr: "" }).reasons.join()).toContain("missing_or_short:titleFr");
    expect(checkContentStructure(product, { ...good, descriptionFr: "<p>Court.</p>" }).reasons).toContain("description_fr_too_short");
    const english =
      "<p>This cat tree is the perfect place for your pet to play and rest with its platforms and the scratching posts that are made for you and your home.</p>".repeat(3);
    expect(checkContentStructure(product, { ...good, descriptionFr: english }).reasons).toContain("description_not_french");
  });
});

describe("layer 2 — judge", () => {
  it("passes when the judge approves", async () => {
    const llm: LlmText = vi.fn().mockResolvedValue('{"ok":true,"issues":[]}');
    expect(await judgeContent(product, good, llm)).toEqual({ ok: true, reasons: [] });
    expect((llm as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({ tier: "strong" });
  });

  it("fails with the judge's issues, tolerating a fenced reply", async () => {
    const llm: LlmText = async () => '```json\n{"ok":false,"issues":[{"type":"invented_fact","detail":"garantie 5 ans"}]}\n```';
    const v = await judgeContent(product, good, llm);
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("invented_fact");
  });

  it("is fail-closed on unreadable or unavailable judges", async () => {
    expect((await judgeContent(product, good, async () => "no json here")).reasons).toEqual(["judge_unparseable"]);
    const v = await judgeContent(product, good, async () => { throw new Error("budget exhausted"); });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("judge_unavailable");
  });

  it("puts the supplier data and the generated copy in the prompt", () => {
    const p = buildJudgePrompt(product, good);
    expect(p).toContain("DONNÉES FOURNISSEUR");
    expect(p).toContain("71 inches");
    expect(p).toContain(good.titleFr);
  });
});

describe("layer 2 — gallery analysis, cleaning and the lifestyle first photo", () => {
  const img = { mediaType: "image/jpeg", data: "AAAA" };
  const flagsJson = (rows: Array<Record<string, unknown>>) => JSON.stringify({ images: rows.map((r, i) => ({ index: i + 1, ...r })) });
  const urls = ["u1", "u2", "u3", "u4", "u5", "u6"];

  it("analyses up to six photos in one call and maps the answers back to URLs", async () => {
    const llm = vi.fn(async () => flagsJson([{ lifestyle: false }, { lifestyle: true }, {}, {}, {}, {}]));
    const a = await analyzeGallery(urls, llm as unknown as LlmText, async () => img);
    expect(a.ok).toBe(true);
    expect(a.flags).toHaveLength(6);
    expect(a.flags[1]).toMatchObject({ url: "u2", lifestyle: true });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("fails when too few photos download, without calling the model", async () => {
    const llm = vi.fn();
    const a = await analyzeGallery(["a", "b", "c", "d"], llm as unknown as LlmText, async (u) => (u === "a" ? img : null));
    expect(a.ok).toBe(false);
    expect(a.reasons[0]).toContain("gallery_too_few_reachable");
    expect(llm).not.toHaveBeenCalled();
  });

  it("is fail-closed on an unreadable or unavailable vision answer", async () => {
    expect((await analyzeGallery(urls, async () => "nope", async () => img)).reasons).toEqual(["gallery_unparseable"]);
    const a = await analyzeGallery(urls, async () => { throw new Error("quota"); }, async () => img);
    expect(a.reasons[0]).toContain("gallery_judge_unavailable");
  });

  it("drops logo / watermark / non-product photos and unreachable ones", async () => {
    const a = await analyzeGallery(urls, async () => flagsJson([{}, { supplier_logo: true }, { watermark: true }, { not_product: true }, {}, {}]), async () => img);
    const c = cleanGallery(urls, a);
    expect(c.dropped.sort()).toEqual(["u2", "u3", "u4"]);
    expect(c.images).toEqual(["u1", "u5", "u6"]);
  });

  it("puts a clean lifestyle scene first, leaving the rest in order", async () => {
    const a = await analyzeGallery(urls, async () => flagsJson([{ lifestyle: false }, { lifestyle: true, text_overlay: true }, { lifestyle: true }, {}, {}, {}]), async () => img);
    const c = cleanGallery(urls, a);
    expect(c.promoted).toBe(true);
    expect(c.hasLifestyle).toBe(true);
    expect(c.images).toEqual(["u3", "u1", "u2", "u4", "u5", "u6"]); // u2 is lifestyle but carries text: skipped
  });

  it("keeps a clean studio photo first when no lifestyle photo exists, and avoids a first photo with text", async () => {
    const plain = cleanGallery(urls, await analyzeGallery(urls, async () => flagsJson([{}, {}, {}, {}, {}, {}]), async () => img));
    expect(plain.images[0]).toBe("u1");
    expect(plain.hasLifestyle).toBe(false);
    expect(plain.promoted).toBe(false);
    const texty = cleanGallery(urls, await analyzeGallery(urls, async () => flagsJson([{ text_overlay: true }, {}, {}, {}, {}, {}]), async () => img));
    expect(texty.images[0]).toBe("u2");
    expect(texty.promoted).toBe(true);
  });

  it("fails when fewer than three clean photos remain", async () => {
    const a = await analyzeGallery(urls, async () => flagsJson([{}, { supplier_logo: true }, { watermark: true }, { not_product: true }, { unreadable: true }, {}]), async () => img);
    expect(cleanGallery(urls, a).reasons).toEqual(["gallery_too_few_clean_photos:2"]);
  });
});

describe("titles", () => {
  const withTitle = (titleFr: string, titleEn = "Multi-level cat tree with scratching posts") => ({ ...good, titleFr, titleEn });
  it("accepts a clear French title", () => {
    expect(checkTitle(product, good)).toEqual({ ok: true, reasons: [] });
  });
  it("rejects company, store, supplier-brand and third-party names", () => {
    const cases: Array<[string, string]> = [
      ["Arbre à chat PawHut multiniveau avec poteaux", "title_fr_supplier_brand"],
      ["Arbre à chat Ameublo Direct multiniveau 180 cm", "title_fr_store_or_supplier_name"],
      ["Voiture électrique Mercedes-Benz pour enfants 12 V", "title_fr_third_party_brand"],
      ["Arbre à chat Zorbo multiniveau de luxe", "title_fr_has_product_brand"],
      ["Arbre à chat GlobeTrot multiniveau avec poteaux", "title_fr_company_like_token"],
      ["Arbre à chat ZORBOX multiniveau avec poteaux", "title_fr_company_like_token"],
    ];
    for (const [t, expected] of cases) {
      const brandProduct = { ...product, brand: expected.endsWith("has_product_brand") ? "Zorbo" : product.brand };
      const v = checkTitle(brandProduct, withTitle(t));
      expect(v.ok, t).toBe(false);
      expect(v.reasons.join(), t).toContain(expected);
    }
  });
  it("lets product vocabulary in capitals through (LED, USB…)", () => {
    expect(checkTitle(product, withTitle("Lampe de chevet LED rechargeable USB avec variateur")).ok).toBe(true);
  });
  it("rejects titles that are truncated, too short, repeated or malformed", () => {
    const cases: Array<[string, string]> = [
      ["Arbre à chat multiniveau avec poteaux à griffer et", "title_fr_ok_baseline"],
      ["Arbre à chat multiniveau avec poteaux -", "truncated"],
      ["Arbre chat", "length"],
      ["arbre à chat multiniveau avec poteaux", "starts_lowercase"],
      ["Arbre à chat arbre à chat arbre chat multiniveau", "repeated_word"],
      ["Arbre à chat | multiniveau avec poteaux", "markup"],
    ];
    for (const [t, expected] of cases.slice(1)) {
      expect(checkTitle(product, withTitle(t)).reasons.join(), t).toContain(expected);
    }
  });
  it("makes the judge able to fail a title that makes no sense", async () => {
    const v = await judgeContent(product, good, async () => '{"ok":true,"title_ok":false,"issues":[]}');
    expect(v).toEqual({ ok: false, reasons: ["judge:title_not_sensible"] });
  });
});

describe("colour swatches change the photo", () => {
  const colourProduct = (images: string[], map: Record<string, string[]>): AosomMergedProduct => ({
    ...product,
    images,
    variants: Object.entries(map).map(([color, imgs], i) => ({ ...product.variants[0], sku: `V-${i}`, color, images: imgs })),
  });
  it("is fine with a single colour, or colours that each own a photo", () => {
    expect(checkColorPhotos(product).ok).toBe(true);
    expect(checkColorPhotos(colourProduct(["a", "b", "c"], { Noir: ["a"], Gris: ["b"] })).ok).toBe(true);
  });
  it("flags a colour without a photo in the gallery, and colours that share one picture", () => {
    expect(checkColorPhotos(colourProduct(["a", "b", "c"], { Noir: ["a"], Gris: ["zzz"] })).reasons).toEqual(["color_without_photo:gris", "colors_share_one_photo"]);
    expect(checkColorPhotos(colourProduct(["a", "b", "c"], { Noir: ["a"], Gris: ["a"] })).reasons).toEqual(["colors_share_one_photo"]);
  });
  it("checks on Shopify that each colour variant carries its own image id", () => {
    const p = colourProduct(["a", "b", "c"], { Noir: ["a"], Gris: ["b"] });
    const base = { handle: "x", status: "draft", published: false, tags: [], imageCount: 3 };
    const good2 = { ...base, variants: [{ sku: "V-0", price: 90, inventoryManagement: null, imageId: 11 }, { sku: "V-1", price: 90, inventoryManagement: null, imageId: 12 }] };
    expect(checkShopifySummary(good2, p)).toEqual({ ok: true, reasons: [] });
    const none = { ...base, variants: [{ sku: "V-0", price: 90, inventoryManagement: null, imageId: null }, { sku: "V-1", price: 90, inventoryManagement: null, imageId: null }] };
    expect(checkShopifySummary(none, p).reasons).toEqual(["variant_without_photo:V-0", "variant_without_photo:V-1", "swatches_do_not_change_photo"]);
    const same = { ...base, variants: [{ sku: "V-0", price: 90, inventoryManagement: null, imageId: 11 }, { sku: "V-1", price: 90, inventoryManagement: null, imageId: 11 }] };
    expect(checkShopifySummary(same, p).reasons).toEqual(["swatches_do_not_change_photo"]);
  });
});

describe("layer 3 — Shopify and storefront", () => {
  const ok = { handle: "arbre-a-chat", status: "draft", published: false, tags: [], imageCount: 4, variants: [{ sku: "D30-1", price: 89.99, inventoryManagement: null }] };
  it("accepts what we meant to create", () => {
    expect(checkShopifySummary(ok, product)).toEqual({ ok: true, reasons: [] });
  });
  it("flags tracked inventory, a price below the supplier's, missing images and wrong variants", () => {
    const v = checkShopifySummary(
      { ...ok, imageCount: 1, handle: "aosom-tree", variants: [{ sku: "D30-1", price: 10, inventoryManagement: "shopify" }, { sku: "X", price: 5, inventoryManagement: null }] },
      product,
    );
    expect(v.reasons.join()).toMatch(/variant_count/);
    expect(v.reasons.join()).toMatch(/price_below_supplier:D30-1/);
    expect(v.reasons.join()).toMatch(/inventory_tracked:D30-1/);
    expect(v.reasons.join()).toMatch(/unknown_sku:X/);
    expect(v.reasons.join()).toMatch(/images:1\/3/);
    expect(v.reasons.join()).toMatch(/supplier_in_handle/);
  });
  it("checks the public page", () => {
    const page = '<html><head><meta property="og:image" content="x"><meta property="og:price:amount" content="89.99"></head><body><h1>Arbre à chat</h1></body></html>';
    expect(checkStorefrontHtml(page)).toEqual({ ok: true, reasons: [] });
    expect(checkStorefrontHtml("<html><body><p>404</p></body></html>").reasons).toEqual(["page_no_h1", "page_no_image", "page_no_price"]);
    expect(checkStorefrontHtml(page.replace("Arbre à chat", "Arbre PawHut")).reasons).toEqual(["page_supplier_brand:pawhut"]);
  });
});
