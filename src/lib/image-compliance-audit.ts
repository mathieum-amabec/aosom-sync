/**
 * Reusable pos-1 image-compliance audit.
 *
 * This is the shared engine behind BOTH:
 *   • the catalog-wide dry-run (scripts/audit-pos1-compliance.mts) — proposes swaps, writes
 *     nothing to Shopify;
 *   • the daily sync guard (image-compliance.ts) — same verdicts, then either queues the
 *     proposal for human approval or applies it, depending on the configured mode.
 *
 * Keeping one engine means the audit that produced an approved list and the guard that runs
 * on the next import can never disagree about what "clean" means.
 *
 * ── What it judges ───────────────────────────────────────────────────────────
 * A compliant pos-1 image carries NO marketing/measurement overlay burned onto the photo
 * (dimension callouts, arrows, slogans, prices, badges, added logos). Text that is part of
 * the photographed scene or product stays clean. The prompt lives in vision-classifier.ts.
 *
 * ── Where candidate images come from ─────────────────────────────────────────
 * The Shopify gallery is NOT a superset of the Aosom feed: the feed rotates images after
 * import, so a product can have feed photos absent from Shopify (measured: ~3 in 8 products).
 * The audit therefore considers the UNION, preferring in-gallery candidates because those
 * can be promoted with a single reorder call; a feed-only candidate is reported with
 * `source: "feed"` and needs an upload before it can become pos-1.
 *
 * ── Why the verdicts are cached by "stem" ────────────────────────────────────
 * The same photo appears under several URLs: the Aosom CDN original, the Shopify copy with
 * an `_<uuid>` ingest suffix, and Shopify's `_1024x1024` resize. imageUrlStem() reduces all
 * three to the Aosom hash, so one photo costs at most one Claude call across the whole
 * catalog and across re-runs (image_classifications table).
 */
import { classifyProductImage, DEFAULT_CLASSIFY_PX, type ClassifyOptions } from "./vision-classifier";
import { fetchProductImages, type ShopifyProductImage } from "./shopify-client";
import { getCachedImageVerdicts, putCachedImageVerdict, type CachedImageVerdict } from "./database";
import { CLAUDE } from "./config";

/** Shopify appends this to a filename when it ingests an external image. */
const SHOPIFY_INGEST_UUID = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Shopify's resize transform, e.g. `_1024x1024`. */
const SHOPIFY_SIZE_SUFFIX = /_\d+x\d+$/;

/**
 * Reduce an image URL to a CDN-agnostic photo identity: the Aosom hash filename, stripped of
 * extension, Shopify's `_<uuid>` ingest suffix and any `_WxH` resize suffix, lowercased.
 *
 *   https://img-us.aosomcdn.com/100/product/2025/07/07/RDY442197e584a03b.jpg
 *   https://cdn.shopify.com/s/files/1/.../RDY442197e584a03b_0bc0d553-…-…ebfb4361aa20.jpg
 *   https://cdn.shopify.com/s/files/1/.../RDY442197e584a03b_1024x1024.jpg
 *                                     → all three: "rdy442197e584a03b"
 *
 * Returns "" for an empty/unusable URL, which callers treat as "not cacheable".
 */
export function imageUrlStem(url: string): string {
  if (!url) return "";
  const file = url.split("?")[0].split("/").pop() || "";
  if (!file) return "";
  let stem = file.replace(/\.[a-z0-9]+$/i, "");
  // Order matters: Shopify can stack both suffixes (`<hash>_<uuid>_1024x1024.jpg`).
  stem = stem.replace(SHOPIFY_SIZE_SUFFIX, "");
  stem = stem.replace(SHOPIFY_INGEST_UUID, "");
  return stem.toLowerCase();
}

/** One candidate image considered for pos-1, from either source. */
export interface AuditCandidate {
  url: string;
  /** Shopify image id — null for a feed-only photo (would need an upload to be promoted). */
  imageId: string | null;
  /** Gallery position at scan time — null for feed-only photos. */
  position: number | null;
  source: "shopify" | "feed";
}

export type Pos1AuditStatus =
  /** pos-1 is already clean — nothing to do. */
  | "compliant"
  /** pos-1 carries an overlay AND a clean alternative exists — a swap is proposed. */
  | "fixable"
  /** pos-1 carries an overlay and EVERY other image does too — nothing better to offer. */
  | "no_alternative"
  /** Budget ran out before the whole set was scanned — verdict deliberately withheld. */
  | "deferred"
  /** The product has no usable image at all. */
  | "no_images"
  /** Download / API / parse failure — never treated as a licence to swap. */
  | "error";

export interface Pos1AuditPlan {
  sku: string;
  shopifyProductId: string;
  name: string;
  status: Pos1AuditStatus;
  /** Current pos-1 image (empty when status is "no_images"). */
  currentUrl: string;
  currentImageId: string | null;
  currentReason: string;
  /** Proposed replacement — only set when status is "fixable". */
  proposedUrl?: string;
  proposedImageId?: string | null;
  proposedPosition?: number | null;
  proposedReason?: string;
  proposedSource?: "shopify" | "feed";
  /** How many candidate images were examined, out of how many were available. */
  scanned: number;
  candidates: number;
  /** Claude vision calls actually spent (cache hits cost 0). */
  calls: number;
  /** Vision calls served from the cache — the reason a re-run is nearly free. */
  cacheHits: number;
  error?: string;
}

/** Shared, mutable call budget so one audit run can cap total spend across products. */
export interface AuditBudget {
  /** Remaining Claude vision calls. Decremented in place. */
  left: number;
}

export interface AuditOptions {
  /** Cap total Claude calls across the whole run. Omit for "no cap". */
  budget?: AuditBudget;
  /** Also consider Aosom feed photos absent from the Shopify gallery. Default true. */
  includeFeedOnly?: boolean;
  /** Persist every fresh verdict to image_classifications. Default true. */
  useCache?: boolean;
  /** Vision call tuning — image size, and whether to step outside the shared LLM pool.
   *  Passed straight through to classifyProductImage; see ClassifyOptions for the
   *  scripts-only caveat on `maintenance`. */
  classifyOptions?: ClassifyOptions;
  /** Injected for tests. */
  classify?: typeof classifyProductImage;
  fetchImages?: typeof fetchProductImages;
}

/**
 * Classify a batch of images, consulting (and filling) the stem cache first.
 *
 * Returns a stem→verdict map covering everything it managed to resolve. Images whose
 * classification threw are simply absent from the map — an unresolved image must never be
 * silently read as "non-compliant" (that would authorise a swap on no evidence).
 */
async function classifyWithCache(
  urls: string[],
  opts: Required<Pick<AuditOptions, "useCache">> & Pick<AuditOptions, "classify" | "classifyOptions">,
  counters: { calls: number; cacheHits: number; lastError?: string },
  budget?: AuditBudget,
): Promise<Map<string, CachedImageVerdict>> {
  const classify = opts.classify ?? classifyProductImage;
  const stems = urls.map(imageUrlStem);
  const verdicts = opts.useCache ? await getCachedImageVerdicts(stems) : new Map<string, CachedImageVerdict>();

  for (let i = 0; i < urls.length; i++) {
    const stem = stems[i];
    if (!stem || verdicts.has(stem)) {
      if (stem && verdicts.has(stem)) counters.cacheHits++;
      continue;
    }
    if (budget && budget.left <= 0) break;
    if (budget) budget.left--;
    counters.calls++;
    try {
      const v = await classify(urls[i], opts.classifyOptions);
      const verdict: CachedImageVerdict = { compliant: v.compliant, reason: v.reason };
      verdicts.set(stem, verdict);
      if (opts.useCache) {
        // Record the model AND the resolution the verdict was produced at: they are the two
        // inputs that decide it, and a cache row is worthless for auditing without them.
        const px = opts.classifyOptions?.px ?? DEFAULT_CLASSIFY_PX;
        await putCachedImageVerdict(stem, verdict, { model: `${CLAUDE.MODEL_BATCH}@${px}`, sampleUrl: urls[i] });
      }
    } catch (err) {
      // Leave the stem unresolved — the caller skips it rather than assuming a verdict.
      // The message is kept so a run can tell a rate-limit burst (retryable) apart from a
      // permanently broken image (not retryable).
      counters.lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return verdicts;
}

/**
 * Build the ordered candidate list for a product: the Shopify gallery in position order,
 * then any Aosom feed photo whose stem is absent from that gallery.
 */
export function buildCandidates(gallery: ShopifyProductImage[], feedImages: string[]): AuditCandidate[] {
  const seen = new Set<string>();
  const out: AuditCandidate[] = [];
  for (const im of gallery) {
    if (!im.src) continue;
    const stem = imageUrlStem(im.src);
    if (stem && seen.has(stem)) continue;
    if (stem) seen.add(stem);
    out.push({ url: im.src, imageId: String(im.id), position: im.position, source: "shopify" });
  }
  for (const url of feedImages) {
    const stem = imageUrlStem(url);
    if (!stem || seen.has(stem)) continue;
    seen.add(stem);
    out.push({ url, imageId: null, position: null, source: "feed" });
  }
  return out;
}

/**
 * Audit ONE product's pos-1 image and, when it is non-compliant, propose the first clean
 * replacement. Pure analysis: this never writes to Shopify and never mutates the product.
 *
 * Cost shape: 1 call when pos-1 is already clean (the common case), plus one call per
 * alternative examined until a clean one is found. Cache hits cost nothing.
 */
export async function auditProductPos1(
  product: { sku: string; shopifyProductId: string; name: string; feedImages?: string[] },
  options: AuditOptions = {},
): Promise<Pos1AuditPlan> {
  const includeFeedOnly = options.includeFeedOnly ?? true;
  const useCache = options.useCache ?? true;
  const fetchImages = options.fetchImages ?? fetchProductImages;
  const counters: { calls: number; cacheHits: number; lastError?: string } = { calls: 0, cacheHits: 0 };

  const base: Pos1AuditPlan = {
    sku: product.sku,
    shopifyProductId: product.shopifyProductId,
    name: product.name,
    status: "error",
    currentUrl: "",
    currentImageId: null,
    currentReason: "",
    scanned: 0,
    candidates: 0,
    calls: 0,
    cacheHits: 0,
  };

  let gallery: ShopifyProductImage[];
  try {
    gallery = await fetchImages(product.shopifyProductId);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const candidates = buildCandidates(gallery, includeFeedOnly ? (product.feedImages ?? []) : []);
  base.candidates = candidates.length;
  if (candidates.length === 0) return { ...base, status: "no_images" };

  // pos-1 is the gallery's position-1 image; fall back to the first candidate when Shopify
  // returns an unordered/short gallery.
  const pos1 = candidates.find((c) => c.source === "shopify" && c.position === 1) ?? candidates[0];
  base.currentUrl = pos1.url;
  base.currentImageId = pos1.imageId;

  // ── Step 1: is the current pos-1 clean? ──
  const pos1Verdicts = await classifyWithCache([pos1.url], { useCache, classify: options.classify, classifyOptions: options.classifyOptions }, counters, options.budget);
  base.calls = counters.calls;
  base.cacheHits = counters.cacheHits;
  base.scanned = 1;

  const pos1Verdict = pos1Verdicts.get(imageUrlStem(pos1.url));
  if (!pos1Verdict) {
    // Either the budget ran out before spending a call, or classification failed.
    if (options.budget && options.budget.left <= 0 && counters.calls === 0) {
      return { ...base, status: "deferred" };
    }
    return { ...base, status: "error", error: counters.lastError ?? "pos-1 classification failed" };
  }

  base.currentReason = pos1Verdict.reason;
  if (pos1Verdict.compliant) return { ...base, status: "compliant" };

  // ── Step 2: pos-1 carries an overlay — find the first clean alternative. ──
  const alternatives = candidates.filter((c) => imageUrlStem(c.url) !== imageUrlStem(pos1.url));
  let truncated = false;

  for (const alt of alternatives) {
    if (options.budget && options.budget.left <= 0) {
      // A clean image may still exist further down: withhold the verdict rather than
      // declaring "no alternative" on a partial scan.
      truncated = true;
      break;
    }
    const altVerdicts = await classifyWithCache([alt.url], { useCache, classify: options.classify, classifyOptions: options.classifyOptions }, counters, options.budget);
    base.calls = counters.calls;
    base.cacheHits = counters.cacheHits;
    base.scanned++;

    const v = altVerdicts.get(imageUrlStem(alt.url));
    if (!v) continue; // unresolved image — skip it, don't let one failure abort the search
    if (!v.compliant) continue;

    return {
      ...base,
      status: "fixable",
      proposedUrl: alt.url,
      proposedImageId: alt.imageId,
      proposedPosition: alt.position,
      proposedReason: v.reason,
      proposedSource: alt.source,
    };
  }

  return { ...base, status: truncated ? "deferred" : "no_alternative" };
}
