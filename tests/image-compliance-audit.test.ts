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

// Background detection is a real network+sharp path. Mocked so these tests stay hermetic;
// the default "unknown" makes every candidate rank equal, i.e. pure gallery order.
const classifyImageBackground = vi.fn();
vi.mock("@/lib/variant-merger", () => ({ classifyImageBackground }));

const { auditProductPos1, imageUrlStem, buildCandidates, orderByBackgroundPreference } =
  await import("@/lib/image-compliance-audit");

type Img = { id: number; position: number; src: string };
const images = (...list: Img[]) => list;
const product = (id = "111") => ({ sku: `${id}-BK`, shopifyProductId: id, name: `Produit ${id}` });

beforeEach(() => {
  classifyProductImage.mockReset();
  fetchProductImages.mockReset();
  getCachedImageVerdicts.mockReset().mockResolvedValue(new Map());
  putCachedImageVerdict.mockReset().mockResolvedValue(undefined);
  classifyImageBackground.mockReset().mockResolvedValue("unknown");
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

// ─── Lifestyle > white background > overlay ────────────────────────────
// The rule: an image carrying a marketing/measurement overlay must NEVER stay at pos-1 when
// the set (Shopify gallery ∪ Aosom feed) holds any clean photo — lifestyle OR white studio
// packshot. Between two clean photos, lifestyle wins.
describe("orderByBackgroundPreference", () => {
  const cand = (url: string, position: number | null = position0(url)) => ({
    url,
    imageId: url,
    position,
    source: "shopify" as const,
  });
  function position0(url: string): number {
    return Number(url.replace(/\D/g, "")) || 1;
  }

  it("ranks lifestyle first, unknown next, white background last", async () => {
    classifyImageBackground.mockImplementation(async (url: string) =>
      url.startsWith("life") ? "lifestyle" : url.startsWith("white") ? "white_bg" : "unknown",
    );

    const out = await orderByBackgroundPreference(
      [cand("white1.jpg"), cand("huh2.jpg"), cand("life3.jpg")],
      classifyImageBackground,
    );

    expect(out.map((c) => c.url)).toEqual(["life3.jpg", "huh2.jpg", "white1.jpg"]);
    expect(out.map((c) => c.background)).toEqual(["lifestyle", "unknown", "white_bg"]);
  });

  it("keeps gallery order between candidates of the same rank (stable sort)", async () => {
    classifyImageBackground.mockResolvedValue("white_bg");

    const out = await orderByBackgroundPreference(
      [cand("a1.jpg"), cand("b2.jpg"), cand("c3.jpg")],
      classifyImageBackground,
    );

    expect(out.map((c) => c.url)).toEqual(["a1.jpg", "b2.jpg", "c3.jpg"]);
  });

  it("degrades to gallery order when detection throws for every candidate", async () => {
    classifyImageBackground.mockRejectedValue(new Error("sharp missing"));

    const out = await orderByBackgroundPreference([cand("a1.jpg"), cand("b2.jpg")], classifyImageBackground);

    expect(out.map((c) => c.url)).toEqual(["a1.jpg", "b2.jpg"]);
    expect(out.map((c) => c.background)).toEqual(["unknown", "unknown"]);
  });
});

describe("auditProductPos1 — replacement priority", () => {
  /** Verdicts keyed by URL, so a test no longer depends on the ORDER calls are made in. */
  const verdictsByUrl = (map: Record<string, boolean>) =>
    classifyProductImage.mockImplementation(async (url: string) => ({
      compliant: map[url] ?? false,
      reason: map[url] ? "propre" : "texte incrusté",
    }));

  it("prefers a clean lifestyle shot over a clean white packshot that comes first in the gallery", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "white.jpg" },
      { id: 3, position: 3, src: "life.jpg" },
    ));
    verdictsByUrl({ "white.jpg": true, "life.jpg": true });
    classifyImageBackground.mockImplementation(async (url: string) =>
      url === "life.jpg" ? "lifestyle" : "white_bg",
    );

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("fixable");
    expect(plan.proposedUrl).toBe("life.jpg");
    expect(plan.proposedBackground).toBe("lifestyle");
  });

  it("proposes the white packshot when it is the only clean image in the whole set", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "alsoOverlay.jpg" },
      { id: 3, position: 3, src: "white.jpg" },
    ));
    verdictsByUrl({ "white.jpg": true });
    classifyImageBackground.mockImplementation(async (url: string) =>
      url === "white.jpg" ? "white_bg" : "lifestyle",
    );

    const plan = await auditProductPos1(product());

    // The overlay must not survive at pos-1 just because the only clean photo is a packshot.
    expect(plan.status).toBe("fixable");
    expect(plan.proposedUrl).toBe("white.jpg");
    expect(plan.proposedBackground).toBe("white_bg");
  });

  it("prefers a clean lifestyle FEED photo over a clean white packshot already in the gallery", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "https://cdn.shopify.com/s/files/1/x/files/OVER.jpg" },
      { id: 2, position: 2, src: "https://cdn.shopify.com/s/files/1/x/files/WHITE.jpg" },
    ));
    const feedLife = "https://img-us.aosomcdn.com/100/product/2025/01/01/LIFE.jpg";
    verdictsByUrl({
      "https://cdn.shopify.com/s/files/1/x/files/WHITE.jpg": true,
      [feedLife]: true,
    });
    classifyImageBackground.mockImplementation(async (url: string) =>
      url === feedLife ? "lifestyle" : "white_bg",
    );

    const plan = await auditProductPos1({ ...product(), feedImages: [feedLife] });

    expect(plan.status).toBe("fixable");
    expect(plan.proposedSource).toBe("feed");
    expect(plan.proposedBackground).toBe("lifestyle");
    // Feed-only: still needs an upload before it can be promoted.
    expect(plan.proposedImageId).toBeNull();
  });

  it("still reports 'no_alternative' when every image in the set carries an overlay", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "o1.jpg" },
      { id: 2, position: 2, src: "o2.jpg" },
      { id: 3, position: 3, src: "o3.jpg" },
    ));
    verdictsByUrl({});
    classifyImageBackground.mockResolvedValue("lifestyle");

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("no_alternative");
    expect(plan.scanned).toBe(3);
  });

  it("spends no extra vision call to apply the preference", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "white.jpg" },
      { id: 3, position: 3, src: "life.jpg" },
    ));
    verdictsByUrl({ "white.jpg": true, "life.jpg": true });
    classifyImageBackground.mockImplementation(async (url: string) =>
      url === "life.jpg" ? "lifestyle" : "white_bg",
    );

    const plan = await auditProductPos1(product());

    // pos-1 + the single reordered winner: the packshot is never classified at all.
    expect(plan.calls).toBe(2);
    expect(classifyProductImage).toHaveBeenCalledTimes(2);
  });

  it("restores pure gallery order with preferLifestyle: false", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "white.jpg" },
      { id: 3, position: 3, src: "life.jpg" },
    ));
    verdictsByUrl({ "white.jpg": true, "life.jpg": true });
    classifyImageBackground.mockImplementation(async (url: string) =>
      url === "life.jpg" ? "lifestyle" : "white_bg",
    );

    const plan = await auditProductPos1(product(), { preferLifestyle: false });

    expect(plan.proposedUrl).toBe("white.jpg");
    expect(classifyImageBackground).not.toHaveBeenCalled();
  });

  it("falls back to gallery order — and still proposes — when background detection fails", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "white.jpg" },
      { id: 3, position: 3, src: "life.jpg" },
    ));
    verdictsByUrl({ "white.jpg": true, "life.jpg": true });
    classifyImageBackground.mockRejectedValue(new Error("image download timeout"));

    const plan = await auditProductPos1(product());

    expect(plan.status).toBe("fixable");
    expect(plan.proposedUrl).toBe("white.jpg");
    expect(plan.proposedBackground).toBe("unknown");
  });
});
