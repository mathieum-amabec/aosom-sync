import { describe, it, expect } from "vitest";
import { imageKey, exclusiveImages, planColourPhotos, colourPhotoIndex } from "@/lib/variant-photos";
import { planProduct, labelContradicts, colourFamilies, type ShopProduct } from "@/lib/variant-photo-guard";
import { ensureVariantPrimaryImages } from "@/lib/variant-merger";
import type { AosomVariant } from "@/types/aosom";

describe("imageKey", () => {
  it("strips the query, extension and the uuid Shopify appends", () => {
    expect(imageKey("https://cdn.shopify.com/s/files/1/products/BCf8da194939d07c8_5cadde4b-1111-2222-3333-444455556666.jpg?v=12")).toBe("bcf8da194939d07c8");
    expect(imageKey("https://img-us.aosomcdn.com/100/product/2026/01/20/BCf8da194939d07c8.jpg")).toBe("bcf8da194939d07c8");
    expect(imageKey("https://cdn/m1234567-3.jpg")).toBe("m1234567-3");
    expect(imageKey(null)).toBe("");
  });
});

describe("exclusiveImages", () => {
  it("drops photos several colours list", () => {
    const m = exclusiveImages([
      { colour: "Noir", images: ["https://a/life.jpg", "https://a/b1.jpg", "https://a/b2.jpg"] },
      { colour: "Blanc", images: ["https://a/life.jpg", "https://a/w1.jpg"] },
    ]);
    expect(m.get("Noir")).toEqual(["https://a/b1.jpg", "https://a/b2.jpg"]);
    expect(m.get("Blanc")).toEqual(["https://a/w1.jpg"]);
  });
});

describe("planColourPhotos", () => {
  const sources = [
    { colour: "Noir", images: ["https://a/b.jpg", "https://a/life.jpg"] },
    { colour: "Blanc", images: ["https://a/w.jpg", "https://a/life.jpg"] },
    { colour: "Gris", images: ["https://a/g.jpg"] },
    { colour: "Vert", images: [] },
  ];
  const gallery = [
    { id: 1, src: "https://cdn/life.jpg" }, { id: 2, src: "https://cdn/b.jpg" }, { id: 3, src: "https://cdn/w.jpg" }, { id: 9, src: "https://cdn/renamed.jpg" },
  ];
  it("keeps a colour on its own photo, and a photo the feed no longer knows", () => {
    const r = planColourPhotos([{ colour: "Noir", currentImageId: 2 }, { colour: "Blanc", currentImageId: 9 }], sources, gallery);
    expect(r.map((a) => a.action)).toEqual(["ok", "ok"]);
  });
  it("moves a colour off another colour's photo", () => {
    const [a] = planColourPhotos([{ colour: "Blanc", currentImageId: 2 }], sources, gallery);
    expect(a).toMatchObject({ action: "attach", imageId: 3 });
  });
  it("moves a colour off a shared lifestyle shot", () => {
    const [a] = planColourPhotos([{ colour: "Noir", currentImageId: 1 }], sources, gallery);
    expect(a).toMatchObject({ action: "attach", imageId: 2 });
  });
  it("fixes colours sharing one photo", () => {
    const r = planColourPhotos([{ colour: "Noir", currentImageId: 2 }, { colour: "Blanc", currentImageId: 2 }], sources, gallery);
    expect(r[1]).toMatchObject({ action: "attach", imageId: 3 });
  });
  it("uploads the colour's photo when the gallery lacks it", () => {
    const [a] = planColourPhotos([{ colour: "Gris", currentImageId: null }], sources, gallery);
    expect(a).toMatchObject({ action: "upload", url: "https://a/g.jpg" });
  });
  it("reports a colour with no photo of its own in the feed", () => {
    const [a] = planColourPhotos([{ colour: "Vert", currentImageId: null }], sources, gallery);
    expect(a.action).toBe("no-source");
  });
  it("keeps a colour with a photo of its own per size", () => {
    const g = [...gallery, { id: 4, src: "https://cdn/b2.jpg" }];
    const s = [{ ...sources[0], images: [...sources[0].images, "https://a/b2.jpg"] }, sources[1]];
    const [a] = planColourPhotos([{ colour: "Noir", currentImageId: null, variantImageIds: [2, 4] }], s, g);
    expect(a.action).toBe("ok");
  });
  it("still fixes a colour when one of its sizes shows another colour, a shared shot or nothing", () => {
    for (const ids of [[2, 3], [2, 1], [2, null]]) {
      const [a] = planColourPhotos([{ colour: "Noir", currentImageId: null, variantImageIds: ids }], sources, gallery);
      expect(a).toMatchObject({ action: "attach", imageId: 2 });
    }
  });
  it("sees a photo used by one size of a colour as shared with another colour", () => {
    const r = planColourPhotos([{ colour: "Noir", currentImageId: null, variantImageIds: [2, 9] }, { colour: "Blanc", currentImageId: 9 }], sources, gallery);
    expect(r.map((a) => a.action)).toEqual(["attach", "attach"]);
  });
  it("finds a colour's index by file", () => {
    expect(colourPhotoIndex("Blanc", sources, ["https://cdn/life.jpg", "https://cdn/w_0f0f0f0f-1111-2222-3333-444444444444.jpg"])).toBe(1);
    expect(colourPhotoIndex("Gris", sources, ["https://cdn/life.jpg"])).toBe(-1);
  });
});

describe("ensureVariantPrimaryImages", () => {
  const v = (sku: string, color: string, images: string[]) => ({ sku, color, images } as unknown as AosomVariant);
  it("adds a colour's own photo even when a shared photo of it is already in the gallery", () => {
    const out = ensureVariantPrimaryImages(["https://a/life.jpg", "https://a/b.jpg"], [v("1", "Noir", ["https://a/life.jpg", "https://a/b.jpg"]), v("2", "Blanc", ["https://a/life.jpg", "https://a/w.jpg"])]);
    expect(out).toContain("https://a/w.jpg");
  });
});

describe("label vs feed", () => {
  it("knows colour families by whole word", () => {
    expect([...colourFamilies("Motif floral")]).toEqual([]);
    expect([...colourFamilies("Gris foncé")]).toEqual(["grey"]);
  });
  it("flags contradictions only", () => {
    expect(labelContradicts("Rose", "Gris")).toBe(true);
    expect(labelContradicts("Blanc", "Argent")).toBe(true);
    expect(labelContradicts("Crème", "Blanc crème")).toBe(false);
    expect(labelContradicts("Noir", "Noir lustré effet marbre")).toBe(false);
    expect(labelContradicts("Multicolore", "Rouge")).toBe(false);
  });
});

describe("planProduct", () => {
  const p: ShopProduct = {
    id: 7, handle: "chaise", tags: "salon",
    options: [{ name: "Couleur", position: 1, values: ["Noir", "Rose"] }],
    variants: [{ id: 71, sku: "A-BK", option1: "Noir", image_id: 2 }, { id: 72, sku: "A-GY", option1: "Rose", image_id: 2 }],
    images: [{ id: 2, src: "https://cdn/b.jpg" }, { id: 3, src: "https://cdn/g.jpg" }],
  };
  const feed = new Map([["A-BK", { color: "Black", images: ["https://a/b.jpg"] }], ["A-GY", { color: "Gray", images: ["https://a/g.jpg"] }]]);
  it("fixes the photo and reports the wrong label", () => {
    const plan = planProduct(p, feed)!;
    expect(plan.actions.find((a) => a.colour === "Rose")).toMatchObject({ action: "attach", imageId: 3, variantIds: [72] });
    expect(plan.labelIssues).toEqual([{ colour: "Rose", sku: "A-GY", feedColour: "Gray" }]);
  });
  it("finds the photo of a colour whose SKU was renamed, through the Aosom group (PSIN)", () => {
    const q: ShopProduct = {
      id: 8, handle: "table", tags: "",
      options: [{ name: "Couleur", position: 1, values: ["Noir", "Blanc"] }],
      variants: [{ id: 81, sku: "T-BK", option1: "Noir", image_id: 5 }, { id: 82, sku: "T-OLDWT", option1: "Blanc", image_id: 5 }],
      images: [{ id: 5, src: "https://cdn/tb.jpg" }],
    };
    const f = new Map([["T-BK", { color: "Black", images: ["https://a/tb.jpg"], psin: "P1" }]]);
    const idx = new Map([["P1", [{ sku: "T-BK", color: "Black", images: ["https://a/tb.jpg"] }, { sku: "T-NEWWT", color: "White", images: ["https://a/tw.jpg"] }]]]);
    expect(planProduct(q, f, idx)!.actions.find((a) => a.colour === "Blanc")).toMatchObject({ action: "upload", url: "https://a/tw.jpg" });
    expect(planProduct(q, f)!.actions.find((a) => a.colour === "Blanc")!.action).toBe("no-source");
  });
  it("keeps one photo per size of the same colour (2026-10-20: 64 L and 127 L bird cages)", () => {
    const c: ShopProduct = {
      id: 9, handle: "cage", tags: "",
      options: [{ name: "Couleur", position: 1, values: ["Gris foncé", "Blanc"] }, { name: "Taille", position: 2, values: ["64L", "127L"] }],
      variants: [
        { id: 91, sku: "C-S", option1: "Gris foncé", option2: "64L", image_id: 1 },
        { id: 92, sku: "C-L", option1: "Gris foncé", option2: "127L", image_id: 2 },
        { id: 93, sku: "C-W", option1: "Blanc", option2: "64L", image_id: 3 },
      ],
      images: [{ id: 1, src: "https://cdn/small.jpg" }, { id: 2, src: "https://cdn/large.jpg" }, { id: 3, src: "https://cdn/white.jpg" }],
    };
    const f = new Map([["C-S", { color: "Black", images: ["https://a/small.jpg"] }], ["C-L", { color: "Black", images: ["https://a/large.jpg"] }], ["C-W", { color: "White", images: ["https://a/white.jpg"] }]]);
    expect(planProduct(c, f)!.actions.map((a) => a.action)).toEqual(["ok", "ok"]);
    const wrong = { ...c, variants: c.variants.map((v) => (v.id === 92 ? { ...v, image_id: 3 } : v)) };
    expect(planProduct(wrong, f)!.actions.find((a) => a.colour === "Gris foncé")).toMatchObject({ action: "attach", imageId: 1, variantIds: [91, 92] });
  });
  it("ignores single-colour products", () => {
    expect(planProduct({ ...p, options: [{ name: "Couleur", position: 1, values: ["Noir"] }] }, feed)).toBeNull();
  });
});

describe("Costway: a variant from another category is not a variant (2026-10-18 snow thrower + ride-on car)", async () => {
  const { sameProductRows } = await import("@/lib/costway/importer");
  it("drops the odd-category variant", () => {
    const rows = [
      { sku: "BL", category: "Outdoor > Garden > Garden Tools > Snow Removal" },
      { sku: "NY", category: "Toys & Hobbies > Ride On Toys > Powered Ride On Toys" },
      { sku: "RE", category: "Outdoor > Garden > Garden Tools > Snow Removal" },
    ];
    expect(sameProductRows(rows).map((r) => r.sku)).toEqual(["BL", "RE"]);
    expect(sameProductRows(rows.slice(0, 1))).toHaveLength(1);
  });
});
