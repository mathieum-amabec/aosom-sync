// hybrid mode routing: an OBVIOUS swap applies itself, an AMBIGUOUS one waits for a human.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { hasShopifyToken: true } }));

const classifyProductImage = vi.fn();
vi.mock("@/lib/vision-classifier", () => ({ classifyProductImage, DEFAULT_CLASSIFY_PX: 1024 }));

const fetchProductImages = vi.fn();
const moveImageToFirstPosition = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ fetchProductImages, moveImageToFirstPosition }));

const getImageComplianceCandidates = vi.fn();
const markImageChecked = vi.fn();
const addSyncLogsBatch = vi.fn();
const getFeedImagesForProducts = vi.fn();
const upsertImageReview = vi.fn();
const getCachedImageVerdicts = vi.fn();
const putCachedImageVerdict = vi.fn();
const getSetting = vi.fn();
vi.mock("@/lib/database", () => ({
  getImageComplianceCandidates, markImageChecked, addSyncLogsBatch,
  getFeedImagesForProducts, upsertImageReview, getCachedImageVerdicts, putCachedImageVerdict, getSetting,
}));

const classifyImageBackground = vi.fn();
vi.mock("@/lib/variant-merger", () => ({ classifyImageBackground }));

const { runImageCompliance } = await import("@/lib/image-compliance");

type Img = { id: number; position: number; src: string };
const images = (...list: Img[]) => list;
const candidate = (id: string) => ({ sku: `${id}-BK`, shopifyProductId: id, name: `Produit ${id}` });

beforeEach(() => {
  classifyProductImage.mockReset();
  fetchProductImages.mockReset();
  moveImageToFirstPosition.mockReset().mockResolvedValue(true);
  getImageComplianceCandidates.mockReset().mockResolvedValue([]);
  markImageChecked.mockReset().mockResolvedValue(undefined);
  addSyncLogsBatch.mockReset().mockResolvedValue(undefined);
  getFeedImagesForProducts.mockReset().mockResolvedValue(new Map());
  upsertImageReview.mockReset().mockResolvedValue(1);
  getCachedImageVerdicts.mockReset().mockResolvedValue(new Map());
  putCachedImageVerdict.mockReset().mockResolvedValue(undefined);
  getSetting.mockReset().mockResolvedValue("hybrid");
  classifyImageBackground.mockReset().mockResolvedValue("unknown");
});

const verdicts = (clean: string[], confidence?: number) =>
  classifyProductImage.mockImplementation(async (url: string) => ({
    compliant: clean.includes(url),
    reason: clean.includes(url) ? "propre" : "cotes incrustées",
    ...(confidence === undefined ? {} : { confidence }),
  }));

describe("runImageCompliance — hybrid", () => {
  it("APPLIES an obvious swap: one clean photo in the set, written straight to Shopify", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("111")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "alsoOverlay.jpg" },
      { id: 3, position: 3, src: "clean.jpg" },
    ));
    verdicts(["clean.jpg"]);

    const res = await runImageCompliance({ syncRunId: "r1" });

    expect(res.mode).toBe("hybrid");
    expect(moveImageToFirstPosition).toHaveBeenCalledWith("111", "3");
    expect(res.swapped).toBe(1);
    expect(res.queued).toBe(0);
    expect(upsertImageReview).not.toHaveBeenCalled();
  });

  it("QUEUES an ambiguous swap: two clean lifestyle photos, nothing written to Shopify", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("222")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "cleanA.jpg" },
      { id: 3, position: 3, src: "cleanB.jpg" },
    ));
    verdicts(["cleanA.jpg", "cleanB.jpg"]);
    classifyImageBackground.mockResolvedValue("lifestyle");

    const res = await runImageCompliance({ syncRunId: "r2" });

    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(res.swapped).toBe(0);
    expect(res.queued).toBe(1);
    expect(upsertImageReview).toHaveBeenCalledTimes(1);
  });

  it("APPLIES when one lifestyle beats several packshots — the coded preference decides", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("333")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "white1.jpg" },
      { id: 3, position: 3, src: "life.jpg" },
      { id: 4, position: 4, src: "white2.jpg" },
    ));
    verdicts(["white1.jpg", "life.jpg", "white2.jpg"]);
    classifyImageBackground.mockImplementation(async (u: string) => (u === "life.jpg" ? "lifestyle" : "white_bg"));

    const res = await runImageCompliance({ syncRunId: "r3" });

    expect(res.swapped).toBe(1);
    expect(moveImageToFirstPosition).toHaveBeenCalledWith("333", "3"); // the lifestyle one
  });

  it("QUEUES a low-confidence verdict even when the set looks clear-cut", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("444")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    verdicts(["clean.jpg"], 0.4);

    const res = await runImageCompliance({ syncRunId: "r4" });

    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(res.queued).toBe(1);
  });

  it("NEVER uploads unattended: a feed-only clean photo is queued even when obvious", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("555")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "https://cdn.shopify.com/s/files/1/x/files/OVER.jpg" },
    ));
    getFeedImagesForProducts.mockResolvedValue(
      new Map([["555", ["https://img-us.aosomcdn.com/100/product/2026/01/01/CLEAN.jpg"]]]),
    );
    verdicts(["https://img-us.aosomcdn.com/100/product/2026/01/01/CLEAN.jpg"]);

    const res = await runImageCompliance({ syncRunId: "r5" });

    // Promoting it means ADDING a photo to a live product — past what unattended mode may do.
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(res.queued).toBe(1);
    expect(upsertImageReview).toHaveBeenCalledWith(expect.objectContaining({ source: "feed", proposedImageId: null }));
  });

  it("leaves a fully dirty set alone and never queues it", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("666")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "o1.jpg" },
      { id: 2, position: 2, src: "o2.jpg" },
    ));
    verdicts([]);

    const res = await runImageCompliance({ syncRunId: "r6" });

    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(upsertImageReview).not.toHaveBeenCalled();
    expect(res.noAlternative).toBe(1);
  });

  it("a clean pos-1 costs one call and touches nothing", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("777")]);
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "clean.jpg" }));
    verdicts(["clean.jpg"]);

    const res = await runImageCompliance({ syncRunId: "r7" });

    expect(res.compliant).toBe(1);
    expect(classifyProductImage).toHaveBeenCalledTimes(1);
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
  });

  it("queue mode still queues an OBVIOUS case — hybrid is opt-in, not a behaviour change", async () => {
    getSetting.mockResolvedValue("queue");
    getImageComplianceCandidates.mockResolvedValue([candidate("888")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    verdicts(["clean.jpg"]);

    const res = await runImageCompliance({ syncRunId: "r8" });

    expect(res.mode).toBe("queue");
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(res.queued).toBe(1);
  });
});
