import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Module mocks (declared before the import under test) ──────────────
// env.hasShopifyToken gates the whole pass — mock config so the token is present.
vi.mock("@/lib/config", () => ({ env: { hasShopifyToken: true } }));

const classifyProductImage = vi.fn();
vi.mock("@/lib/vision-classifier", () => ({ classifyProductImage }));

const fetchProductImages = vi.fn();
const moveImageToFirstPosition = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ fetchProductImages, moveImageToFirstPosition }));

const getImageComplianceCandidates = vi.fn();
const markImageChecked = vi.fn();
const addSyncLogsBatch = vi.fn();
vi.mock("@/lib/database", () => ({ getImageComplianceCandidates, markImageChecked, addSyncLogsBatch }));

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
});

describe("runImageCompliance", () => {
  it("no-ops when there are no candidates", async () => {
    const res = await runImageCompliance({ syncRunId: "run-1" });
    expect(res).toMatchObject({ checked: 0, swapped: 0, classifications: 0 });
    expect(classifyProductImage).not.toHaveBeenCalled();
    expect(markImageChecked).not.toHaveBeenCalled();
  });

  it("no-ops immediately when the budget is 0 (no candidate query)", async () => {
    const res = await runImageCompliance({ syncRunId: "run-1", maxClassifications: 0 });
    expect(res.classifications).toBe(0);
    expect(getImageComplianceCandidates).not.toHaveBeenCalled();
  });

  it("leaves a compliant pos-1 untouched but marks it checked", async () => {
    getImageComplianceCandidates.mockResolvedValue([candidate("111")]);
    fetchProductImages.mockResolvedValue(images({ id: 1, position: 1, src: "p1.jpg" }, { id: 2, position: 2, src: "p2.jpg" }));
    classifyProductImage.mockResolvedValue({ compliant: true, reason: "image propre" });

    const res = await runImageCompliance({ syncRunId: "run-1" });

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

    const res = await runImageCompliance({ syncRunId: "run-1" });

    expect(res).toMatchObject({ checked: 1, nonCompliant: 1, swapped: 1, noAlternative: 0, classifications: 2, errors: 0 });
    expect(moveImageToFirstPosition).toHaveBeenCalledWith("111", 2);
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

    const res = await runImageCompliance({ syncRunId: "run-1" });

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

    const res = await runImageCompliance({ syncRunId: "run-1", maxClassifications: 1 });

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

    const res = await runImageCompliance({ syncRunId: "run-1" });

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

    const res = await runImageCompliance({ syncRunId: "run-1" });

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

    const res = await runImageCompliance({ syncRunId: "run-1" });

    expect(res.errors).toBe(1);
    expect(res.checked).toBe(1); // second product still processed
    expect(markImageChecked).toHaveBeenCalledWith(["777"]); // failed one not stamped → retried next run
  });
});
