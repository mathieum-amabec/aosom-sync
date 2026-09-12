// Obvious-vs-ambiguous routing (hybrid mode) and the import-time pos-1 guard.
import { describe, it, expect, vi, beforeEach } from "vitest";

const classifyProductImage = vi.fn();
vi.mock("@/lib/vision-classifier", () => ({ classifyProductImage, DEFAULT_CLASSIFY_PX: 1024 }));

const fetchProductImages = vi.fn();
vi.mock("@/lib/shopify-client", () => ({ fetchProductImages }));

const getCachedImageVerdicts = vi.fn();
const putCachedImageVerdict = vi.fn();
vi.mock("@/lib/database", () => ({ getCachedImageVerdicts, putCachedImageVerdict }));

const classifyImageBackground = vi.fn();
vi.mock("@/lib/variant-merger", () => ({ classifyImageBackground }));

const {
  auditProductPos1,
  classifySwapDecision,
  enforceCleanPrimaryImage,
  MIN_AUTO_CONFIDENCE,
} = await import("@/lib/image-compliance-audit");

type Img = { id: number; position: number; src: string };
const images = (...list: Img[]) => list;
const product = (id = "111") => ({ sku: `${id}-BK`, shopifyProductId: id, name: `Produit ${id}` });
type Bg = "lifestyle" | "white_bg" | "unknown";

beforeEach(() => {
  classifyProductImage.mockReset();
  fetchProductImages.mockReset();
  getCachedImageVerdicts.mockReset().mockResolvedValue(new Map());
  putCachedImageVerdict.mockReset().mockResolvedValue(undefined);
  classifyImageBackground.mockReset().mockResolvedValue("unknown");
});

/** Verdicts keyed by URL, so a test never depends on the ORDER calls happen in. */
const verdictsByUrl = (map: Record<string, boolean>, confidence?: number) =>
  classifyProductImage.mockImplementation(async (url: string) => ({
    compliant: map[url] ?? false,
    reason: map[url] ? "propre" : "texte incrusté",
    ...(confidence === undefined ? {} : { confidence }),
  }));

describe("classifySwapDecision", () => {
  const cc = (background: Bg, confidence?: number) => ({
    candidate: { url: `${background}.jpg`, imageId: "1", position: 2, source: "shopify" as const },
    background,
    reason: "propre",
    confidence,
  });

  it("one clean photo in the whole set is obvious", () => {
    const out = classifySwapDecision([cc("lifestyle")]);
    expect(out.decision).toBe("obvious");
    expect(out.reason).toContain("une seule alternative propre");
  });

  it("one lifestyle against several packshots is OBVIOUS — the coded preference decides", () => {
    expect(classifySwapDecision([cc("lifestyle"), cc("white_bg"), cc("white_bg")]).decision).toBe("obvious");
  });

  it("two lifestyle photos are ambiguous — nothing breaks that tie", () => {
    const out = classifySwapDecision([cc("lifestyle"), cc("lifestyle"), cc("white_bg")]);
    expect(out.decision).toBe("ambiguous");
    expect(out.reason).toContain("lifestyle");
  });

  it("several packshots and no lifestyle is ambiguous too", () => {
    const out = classifySwapDecision([cc("white_bg"), cc("white_bg")]);
    expect(out.decision).toBe("ambiguous");
    expect(out.reason).toContain("fond blanc");
  });

  it("no clean alternative is ambiguous, never obvious", () => {
    expect(classifySwapDecision([]).decision).toBe("ambiguous");
  });

  it("a hedged pos-1 verdict sends an otherwise obvious set to a human", () => {
    const out = classifySwapDecision([cc("lifestyle")], 0.5);
    expect(out.decision).toBe("ambiguous");
    expect(out.reason).toContain("confiance faible");
  });

  it("a hedged verdict on the PROPOSED photo does the same", () => {
    expect(classifySwapDecision([cc("lifestyle", 0.4)], 0.99).decision).toBe("ambiguous");
  });

  it("UNKNOWN confidence is not low confidence — legacy cached rows stay auto-appliable", () => {
    // The 3,127 rows cached before the column existed report undefined. Reading that as "low"
    // would route the entire back catalogue to the queue.
    expect(classifySwapDecision([cc("lifestyle", undefined)], undefined).decision).toBe("obvious");
  });

  it("the confidence threshold is inclusive", () => {
    expect(classifySwapDecision([cc("lifestyle", MIN_AUTO_CONFIDENCE)]).decision).toBe("obvious");
    expect(classifySwapDecision([cc("lifestyle", MIN_AUTO_CONFIDENCE - 0.01)]).decision).toBe("ambiguous");
  });
});

describe("auditProductPos1 — scanAllAlternatives", () => {
  it("stops at the first clean photo by default, and offers NO decision", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "cleanA.jpg" },
      { id: 3, position: 3, src: "cleanB.jpg" },
    ));
    verdictsByUrl({ "cleanA.jpg": true, "cleanB.jpg": true });

    const plan = await auditProductPos1(product());

    expect(plan.calls).toBe(2);
    expect(plan.cleanAlternatives).toBe(1);
    // A decision from a partial scan would be a guess dressed up as a fact.
    expect(plan.decision).toBeUndefined();
  });

  it("scans the whole set when asked, counts every clean photo, and labels the case", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "cleanA.jpg" },
      { id: 3, position: 3, src: "cleanB.jpg" },
    ));
    verdictsByUrl({ "cleanA.jpg": true, "cleanB.jpg": true });
    classifyImageBackground.mockResolvedValue("lifestyle");

    const plan = await auditProductPos1(product(), { scanAllAlternatives: true });

    expect(plan.calls).toBe(3);
    expect(plan.cleanAlternatives).toBe(2);
    expect(plan.decision).toBe("ambiguous");
  });

  it("labels a single clean photo obvious, and still proposes it", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "alsoOverlay.jpg" },
      { id: 3, position: 3, src: "clean.jpg" },
    ));
    verdictsByUrl({ "clean.jpg": true });
    classifyImageBackground.mockResolvedValue("white_bg");

    const plan = await auditProductPos1(product(), { scanAllAlternatives: true });

    expect(plan.status).toBe("fixable");
    expect(plan.proposedUrl).toBe("clean.jpg");
    expect(plan.cleanAlternatives).toBe(1);
    expect(plan.decision).toBe("obvious");
  });

  it("reports no_alternative with a zero count when the whole set is dirty", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "o1.jpg" },
      { id: 2, position: 2, src: "o2.jpg" },
    ));
    verdictsByUrl({});

    const plan = await auditProductPos1(product(), { scanAllAlternatives: true });

    expect(plan.status).toBe("no_alternative");
    expect(plan.cleanAlternatives).toBe(0);
  });

  it("a hedged model verdict makes an otherwise single-candidate set ambiguous end to end", async () => {
    fetchProductImages.mockResolvedValue(images(
      { id: 1, position: 1, src: "overlay.jpg" },
      { id: 2, position: 2, src: "clean.jpg" },
    ));
    verdictsByUrl({ "clean.jpg": true }, 0.4);
    classifyImageBackground.mockResolvedValue("lifestyle");

    const plan = await auditProductPos1(product(), { scanAllAlternatives: true });

    expect(plan.status).toBe("fixable");
    expect(plan.decision).toBe("ambiguous");
    expect(plan.decisionReason).toContain("confiance faible");
  });
});

describe("enforceCleanPrimaryImage — the import-time guard", () => {
  const classify = vi.fn();
  const run = (imgs: string[]) => enforceCleanPrimaryImage(imgs, { classify, useCache: false });

  beforeEach(() => classify.mockReset());

  it("leaves a clean pos-1 alone after ONE call", async () => {
    classify.mockResolvedValue({ compliant: true, reason: "propre" });

    const out = await run(["a.jpg", "b.jpg", "c.jpg"]);

    expect(out.outcome).toBe("clean");
    expect(out.images).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(out.calls).toBe(1);
  });

  it("promotes the first clean photo when pos-1 carries text", async () => {
    classify.mockImplementation(async (url: string) => ({
      compliant: url === "c.jpg",
      reason: url === "c.jpg" ? "propre" : "cotes incrustées",
    }));

    const out = await run(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);

    expect(out.outcome).toBe("reordered");
    expect(out.images).toEqual(["c.jpg", "a.jpg", "b.jpg", "d.jpg"]);
    expect(out.promotedFrom).toBe(2);
  });

  it("imports UNCHANGED when every photo carries text — never blocks the import", async () => {
    classify.mockResolvedValue({ compliant: false, reason: "overlay" });

    const out = await run(["a.jpg", "b.jpg"]);

    expect(out.outcome).toBe("no_alternative");
    expect(out.images).toEqual(["a.jpg", "b.jpg"]);
  });

  it("imports UNCHANGED when classification fails — an image opinion never blocks an import", async () => {
    // A PLAIN function, not the vi.fn: vitest keeps its own reference to a mock call's
    // rejected promise, and nothing ever consumes that copy, so a throwing vi.fn surfaces as
    // an unhandled rejection even though the code under test catches the real one.
    const throwing = async () => { throw new Error("429 rate limited"); };

    const out = await enforceCleanPrimaryImage(["a.jpg", "b.jpg"], { classify: throwing, useCache: false });

    expect(out.outcome).toBe("skipped");
    expect(out.images).toEqual(["a.jpg", "b.jpg"]);
  });

  it("handles an empty image list without calling the classifier", async () => {
    const out = await run([]);
    expect(out.outcome).toBe("skipped");
    expect(classify).not.toHaveBeenCalled();
  });

  it("skips an unreadable alternative and keeps looking", async () => {
    classify.mockImplementation(async (url: string) => {
      if (url === "b.jpg") throw new Error("download 404");
      return { compliant: url === "c.jpg", reason: "x" };
    });

    const out = await run(["a.jpg", "b.jpg", "c.jpg"]);

    expect(out.outcome).toBe("reordered");
    expect(out.images[0]).toBe("c.jpg");
  });

  it("costs exactly one call on the common case — the cost claim for the import guard", async () => {
    classify.mockResolvedValue({ compliant: true, reason: "propre" });

    const out = await run(["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg", "f.jpg"]);

    // 5 of 6 imports have a clean pos-1 already; a 6-image set must not cost 6 calls.
    expect(out.calls).toBe(1);
  });
});
