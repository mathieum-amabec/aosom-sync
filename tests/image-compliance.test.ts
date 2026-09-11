import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (declared before the import under test) ──────────────
// env.hasShopifyToken gates the whole pass — mock config so the token is present.
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

const { runImageCompliance } = await import("@/lib/image-compliance");

type Img = { id: number; position: number; src: string };
const candidate = (id: string, sku = `${id}-BK`) => ({ sku, shopifyProductId: id, name: `Produit ${id}` });
const images = (...list: Img[]) => list;

beforeEach(() => {
  classifyProductImage.mockReset();
  fetchProductImages.mockReset();
  moveImageToFirstPosition.mockReset();
  getImageComplianceCandidates.mockReset().mockResolvedValue([]);
  markImageChecked.mockReset().mockResolvedValue(undefined);
  addSyncLogsBatch.mockReset().mockResolvedValue(undefined);
  getFeedImagesForProducts.mockReset().mockResolvedValue(new Map());
  upsertImageReview.mockReset().mockResolvedValue(1);
  // The audit engine consults the verdict cache first; an empty cache forces a real call.
  getCachedImageVerdicts.mockReset().mockResolvedValue(new Map());
  putCachedImageVerdict.mockReset().mockResolvedValue(undefined);
  getSetting.mockReset().mockResolvedValue(null);
});

/** The legacy auto-swap behaviour is now one mode among three; pin it explicitly. */
const AUTO = { mode: "auto" as const };

describe("runImageCompliance", () => {
  it("no-ops when there are no candidates", async () => {
    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });
    expect(res).toMatchObject({ checked: 0, swapped: 0, classifications: 0 });
    expect(classifyProductImage).not.toHaveBeenCalled();
    expect(markImageChecked).not.toHaveBeenCalled();
  });

  it("no-ops immediately when the budget is 0 (no candidate query)", async () => {
    const res = await runImageCompliance({ syncRunId: "run-1", maxClassifications: 0, ...AUTO });
    expect(res.classifications).toBe(0);
    expect(getImageComplianceCandidates).not.toHaveBeenCalled();
  });

  it("leaves a compliant pos-1 untouched but marks it checked", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("111")]);
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "p1.jpg" }, { id: 2, position: 2, src: "p2.jpg" }));
    classifyProductImage.mockResolvedValue({ compliant: true, reason: "image propre" });

    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });

    expect(res).toMatchObject({ checked: 1, compliant: 1, nonCompliant: 0, swapped: 0, classifications: 1 });
    expect(classifyProductImage).toHaveBeenCalledTimes(1); // only pos-1, no gallery scan
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(markImageChecked).toHaveBeenCalledWith(["111"]);
    expect(addSyncLogsBatch).not.toHaveBeenCalled();
  });

  it("swaps in the first clean alternative and logs the swap", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("111", "A-BK")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
      { id: 3, position: 3, src: "other.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "badge -50%" }) // pos-1
      .mockResolvedValueOnce({ compliant: true, reason: "scène propre" }); // alt id=2
    moveImageToFirstPosition.mockResolvedValue(true);

    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });

    expect(res).toMatchObject({ checked: 1, nonCompliant: 1, swapped: 1, noAlternative: 0, classifications: 2, errors: 0 });
    expect(moveImageToFirstPosition).toHaveBeenCalledWith("111", "2");
    expect(markImageChecked).toHaveBeenCalledWith(["111"]);
    expect(addSyncLogsBatch).toHaveBeenCalledTimes(1);
    const entry = addSyncLogsBatch.mock.calls[0][0][0];
    expect(entry).toMatchObject({ syncRunId: "run-1", shopifyProductId: "111", sku: "A-BK", action: "update", field: "images" });
    expect(entry.oldValue).toContain("non conforme");
    expect(entry.newValue).toContain("remplacé");
  });

  it("records noAlternative when every gallery image is also non-compliant", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("222")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay1.jpg" },
      { id: 2, position: 2, src: "overlay2.jpg" },
    ));
    classifyProductImage.mockResolvedValue({ compliant: false, reason: "texte incrusté" });

    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });

    expect(res).toMatchObject({ nonCompliant: 1, swapped: 0, noAlternative: 1, classifications: 2 });
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(addSyncLogsBatch).not.toHaveBeenCalled();
  });

  it("never exceeds the classification budget across pos-1 + gallery scan", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("333")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "a.jpg" },
      { id: 3, position: 3, src: "b.jpg" },
    ));
    classifyProductImage.mockResolvedValue({ compliant: false, reason: "overlay" });

    const res = await runImageCompliance({ syncRunId: "run-1", maxClassifications: 1, ...AUTO });

    // Budget of 1 is fully spent on pos-1; the gallery scan can't run. This is a DEFERRAL,
    // not a real "no alternative" — the product must stay UNSTAMPED so a later run finishes it.
    expect(res.classifications).toBe(1);
    expect(classifyProductImage).toHaveBeenCalledTimes(1);
    expect(res.deferred).toBe(1);
    expect(res.noAlternative).toBe(0);
    expect(markImageChecked).not.toHaveBeenCalled();
  });

  it("counts an unverified Shopify swap as an error, not a swap", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("444")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "overlay" })
      .mockResolvedValueOnce({ compliant: true, reason: "propre" });
    moveImageToFirstPosition.mockResolvedValue(false); // Shopify never confirmed pos-1

    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });

    expect(res.swapped).toBe(0);
    expect(res.errors).toBe(1);
    expect(addSyncLogsBatch).not.toHaveBeenCalled();
    // The overlay is still live at pos-1 — the product must NOT be stamped checked, so the
    // next run retries the swap instead of abandoning it permanently.
    expect(markImageChecked).not.toHaveBeenCalled();
  });

  it("marks a product with no images as checked without classifying", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("555")]);
    fetchProductImages.mockResolvedValue(images());

    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });

    expect(res.classifications).toBe(0);
    expect(classifyProductImage).not.toHaveBeenCalled();
    expect(markImageChecked).toHaveBeenCalledWith(["555"]);
  });

  it("is non-fatal: a per-product error is counted and does not throw", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("666"), candidate("777")]);
    fetchProductImages
      .mockRejectedValueOnce(new Error("Shopify 500"))
      .mockResolvedValueOnce(images({ id: 1, position: 1, src: "p.jpg" }));
    classifyProductImage.mockResolvedValue({ compliant: true, reason: "propre" });

    const res = await runImageCompliance({ syncRunId: "run-1", ...AUTO });

    expect(res.errors).toBe(1);
    expect(res.checked).toBe(1); // second product still processed
    expect(markImageChecked).toHaveBeenCalledWith(["777"]); // failed one not stamped → retried next run
  });
});

describe("runImageCompliance — queue mode (human approval)", () => {
  it("queues a proposed swap and writes NOTHING to Shopify", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("111", "A-BK")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "cotes incrustées" })
      .mockResolvedValueOnce({ compliant: true, reason: "scène propre" });

    const res = await runImageCompliance({ syncRunId: "run-1", mode: "queue" });

    expect(res).toMatchObject({ mode: "queue", nonCompliant: 1, queued: 1, swapped: 0 });
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(upsertImageReview).toHaveBeenCalledTimes(1);
    expect(upsertImageReview.mock.calls[0][0]).toMatchObject({
      shopifyProductId: "111", sku: "A-BK", proposedImageId: "2", proposedPosition: 2, source: "shopify",
    });
    // Stamped checked: the pending review row now carries the state, so the next sync must
    // not re-burn the budget re-deriving the same proposal.
    expect(markImageChecked).toHaveBeenCalledWith(["111"]);
    const entry = addSyncLogsBatch.mock.calls[0][0][0];
    expect(entry.newValue).toContain("EN ATTENTE D'APPROBATION");
  });

  it("leaves a product with no clean alternative alone, and does not queue it", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("222")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "o1.jpg" },
      { id: 2, position: 2, src: "o2.jpg" },
    ));
    classifyProductImage.mockResolvedValue({ compliant: false, reason: "overlay" });

    const res = await runImageCompliance({ syncRunId: "run-1", mode: "queue" });

    expect(res).toMatchObject({ noAlternative: 1, queued: 0, swapped: 0 });
    expect(upsertImageReview).not.toHaveBeenCalled();
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(markImageChecked).toHaveBeenCalledWith(["222"]);
  });

  it("queues — never auto-applies — a clean image that exists only in the Aosom feed", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("333")]);
    getFeedImagesForProducts.mockResolvedValue(new Map([["333", ["https://img-us.aosomcdn.com/100/product/2025/01/01/ZZZ.jpg"]]]));
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "https://cdn.shopify.com/s/files/1/x/files/AAA.jpg" }));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "cotes" })
      .mockResolvedValueOnce({ compliant: true, reason: "propre" });

    // Even in AUTO mode a feed-only photo cannot be promoted by a reorder — it needs an
    // upload first — so it must fall back to the approval queue rather than be applied.
    const res = await runImageCompliance({ syncRunId: "run-1", mode: "auto" });

    expect(res.queued).toBe(1);
    expect(res.swapped).toBe(0);
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
    expect(upsertImageReview.mock.calls[0][0]).toMatchObject({ source: "feed", proposedImageId: null });
  });

  it("mode=off is a complete no-op", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("444")]);

    const res = await runImageCompliance({ syncRunId: "run-1", mode: "off" });

    expect(res).toMatchObject({ mode: "off", checked: 0, classifications: 0 });
    expect(getImageComplianceCandidates).not.toHaveBeenCalled();
    expect(classifyProductImage).not.toHaveBeenCalled();
  });

  it("defaults to queue mode when the setting is unset", async () => {
    getSetting.mockResolvedValue(null);
    getImageComplianceCandidates.mockResolvedValue([candidate("555")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "overlay" })
      .mockResolvedValueOnce({ compliant: true, reason: "propre" });

    const res = await runImageCompliance({ syncRunId: "run-1" });

    expect(res.mode).toBe("queue");
    expect(moveImageToFirstPosition).not.toHaveBeenCalled();
  });

  it("honours mode=auto from the setting", async () => {
    getSetting.mockResolvedValue("auto");
    getImageComplianceCandidates.mockResolvedValue([candidate("666")]);
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    classifyProductImage
      .mockResolvedValueOnce({ compliant: false, reason: "overlay" })
      .mockResolvedValueOnce({ compliant: true, reason: "propre" });
    moveImageToFirstPosition.mockResolvedValue(true);

    const res = await runImageCompliance({ syncRunId: "run-1" });

    expect(res.mode).toBe("auto");
    expect(res.swapped).toBe(1);
  });
});
