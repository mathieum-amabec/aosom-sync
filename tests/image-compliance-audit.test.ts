import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (declared before the import under test) ──────────────
const classifyProductImage = vi.fn();
vi.mock("@/lib/vision-classifier", () => ({
  classifyProductImage,
  DEFAULT_CLASSIFY_PX: 1024,
}));

const fetchProductImages = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ fetchProductImages }));

const getCachedImageVerdicts = vi.fn();
const putCachedImageVerdict = vi.fn();
vi.mock("@/lib/database", () => ({ getCachedImageVerdicts, putCachedImageVerdict }));

const { auditProductPos1, imageUrlStem, buildCandidates } = await import("@/lib/image-compliance-audit");

type Img = { id: number; position: number; src: string };
const images = (...list: Img[]) => list;
const product = (id = "111") => ({ sku: `${id}-BK`, shopifyProductId: id, name: `Produit ${id}` });

beforeEach(() => {
  classifyProductImage.mockReset();
  fetchProductImages.mockReset();
  getCachedImageVerdicts.mockReset().mockResolvedValue(new Map());
  putCachedImageVerdict.mockReset().mockResolvedValue(undefined);
});

describe("imageUrlStem", () => {
  it("reduces the Aosom CDN original and both Shopify variants to one identity", () => {
    const aosom = "https://img-us.aosomcdn.com/100/product/2025/07/07/RDY442197e584a03b.jpg";
    const ingested = "https://cdn.shopify.com/s/files/1/0678/1327/7801/files/RDY442197e584a03b_0bc0d553-5be4-4aac-b827-ebfb4361aa20.jpg";
    const resized = "https://cdn.shopify.com/s/files/1/0678/1327/7801/files/RDY442197e584a03b_1024x1024.jpg?v=17807";

    expect(imageUrlStem(aosom)).toBe("rdy442197e584a03b");
    expect(imageUrlStem(ingested)).toBe("rdy442197e584a03b");
    expect(imageUrlStem(resized)).toBe("rdy442197e584a03b");
  });

  it("strips a stacked uuid + size suffix", () => {
    const both = "https://cdn.shopify.com/s/files/1/x/files/ABC123_0bc0d553-5be4-4aac-b827-ebfb4361aa20_512x512.jpg";
    expect(imageUrlStem(both)).toBe("abc123");
  });

  it("returns '' for an empty url", () => {
    expect(imageUrlStem("")).toBe("");
  });
});

describe("buildCandidates", () => {
  it("keeps gallery order then appends only feed photos Shopify does not already have", () => {
    const gallery = images(
      { id: 1, position: 1, src: "https://cdn.shopify.com/s/files/1/x/files/AAA_1024x1024.jpg" },
      { id: 2, position: 2, src: "https://cdn.shopify.com/s/files/1/x/files/BBB.jpg" },
    );
    const feed = [
      "https://img-us.aosomcdn.com/100/product/2025/01/01/AAA.jpg", // same photo as gallery #1
      "https://img-us.aosomcdn.com/100/product/2025/01/01/CCC.jpg", // feed-only
    ];

    const out = buildCandidates(gallery, feed);

    expect(out.map((c) => c.source)).toEqual(["shopify", "shopify", "feed"]);
    expect(out[2].url).toContain("CCC");
    expect(out[2].imageId).toBeNull();
  });
});

describe("auditProductPos1", () => {
  it("reports 'compliant' after a single call when pos-1 is clean", async () => {
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "a.jpg" }, { id: 2, position: 2, src: "b.jpg" }));
    classifyProductImage.mockResolvedValue({ compliant: true, reason: "propre" });

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("compliant");
    expect(plan.calls).toBe(1);
    expect(classifyProductImage).toHaveBeenCalledTimes(1);
  });

  it("proposes the first clean alternative, in gallery order", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "alsoOverlay.jpg" },
      { id: 3, position: 3, src: "clean.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "mesures incrustées" })
      .mockResolvedValueOnce({ compliant: false, reason: "slogan" })
      .mockResolvedValueOnce({ compliant: true, reason: "scène propre" });

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("fixable");
    expect(plan.proposedImageId).toBe("3");
    expect(plan.proposedPosition).toBe(3);
    expect(plan.proposedSource).toBe("shopify");
    expect(plan.calls).toBe(3);
  });

  it("falls back to a feed-only photo when the whole Shopify gallery is dirty", async () => {
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "https://cdn.shopify.com/s/files/1/x/files/AAA.jpg" }));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "cotes" })
      .mockResolvedValueOnce({ compliant: true, reason: "propre" });

    const plan = await auditProductPos1({
      ...product(),
      feedImages: ["https://img-us.aosomcdn.com/100/product/2025/01/01/ZZZ.jpg"],
    });

    expect(plan.status).toBe("fixable");
    expect(plan.proposedSource).toBe("feed");
    // No Shopify image id: promoting it would need an upload first, so the caller must not
    // treat this as a plain reorder.
    expect(plan.proposedImageId).toBeNull();
  });

  it("reports 'no_alternative' only after the WHOLE set was scanned", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "o1.jpg" },
      { id: 2, position: 2, src: "o2.jpg" },
    ));
    classifyProductImage.mockResolvedValue({ compliant: false, reason: "overlay" });

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("no_alternative");
    expect(plan.scanned).toBe(2);
  });

  it("defers instead of claiming 'no_alternative' when the budget truncates the scan", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "o1.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    classifyProductImage.mockResolvedValue({ compliant: false, reason: "overlay" });

    const plan = await auditProductPos1(product(), { budget: { left: 1 } });

    expect(plan.status).toBe("deferred");
    expect(plan.calls).toBe(1);
  });

  it("uses a cached verdict instead of spending a call", async () => {
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "https://cdn.shopify.com/s/files/1/x/files/AAA.jpg" }));
    getCachedImageVerdicts.mockResolvedValue(new Map([["aaa", { compliant: true, reason: "déjà jugée propre" }]]));

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("compliant");
    expect(plan.calls).toBe(0);
    expect(plan.cacheHits).toBe(1);
    expect(classifyProductImage).not.toHaveBeenCalled();
  });

  it("never treats a failed classification as non-compliant", async () => {
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "a.jpg" }));
    classifyProductImage.mockRejectedValue(new Error("429 rate limited"));

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("error");
    expect(plan.error).toContain("429");
  });

  it("skips one unreadable alternative and keeps searching", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "broken.jpg" },
      { id: 3, position: 3, src: "clean.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "overlay" })
      .mockRejectedValueOnce(new Error("image download 404"))
      .mockResolvedValueOnce({ compliant: true, reason: "propre" });

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("fixable");
    expect(plan.proposedImageId).toBe("3");
  });

  it("reports 'no_images' for a product with an empty gallery and no feed", async () => {
    fetchProductImages.mockResolvedValue(images());

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("no_images");
    expect(classifyProductImage).not.toHaveBeenCalled();
  });

  it("surfaces a Shopify fetch failure as an error without classifying", async () => {
    fetchProductImages.mockRejectedValue(new Error("Shopify 500"));

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("error");
    expect(plan.error).toContain("Shopify 500");
    expect(classifyProductImage).not.toHaveBeenCalled();
  });
});
