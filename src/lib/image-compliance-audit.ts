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
import { classifyImageBackground, type ImageBackground } from "./variant-merger";
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
  /** Background of the proposed replacement, when it could be determined. Reported so the
   *  approval queue can show WHY this photo won over the others in the set. */
  proposedBackground?: ImageBackground;
  /** How many CLEAN alternatives the scan found. Only meaningful with `scanAllAlternatives`;
   *  without it the scan stops at the first clean photo, so this is 0 or 1 by construction. */
  cleanAlternatives?: number;
  /** "obvious" = safe to apply unattended; "ambiguous" = a human should pick. See
   *  `classifySwapDecision`. Only set when the whole set was scanned. */
  decision?: SwapDecision;
  /** Plain-French why, surfaced in the queue and the logs. */
  decisionReason?: string;
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
  /**
   * Among the CLEAN alternatives, prefer a lifestyle shot over a white studio packshot.
   * Default true. See `orderByBackgroundPreference` for why this is an ordering and not a
   * filter. Set false to restore pure gallery order (what shipped in v0.5.90.0).
   */
  preferLifestyle?: boolean;
  /**
   * Keep scanning after the first clean photo so the WHOLE set is known. Required to tell an
   * obvious swap from an ambiguous one (see `classifySwapDecision`), and therefore required by
   * hybrid mode. Costs one vision call per extra image; default false.
   */
  scanAllAlternatives?: boolean;
  /** Injected for tests. */
  classify?: typeof classifyProductImage;
  fetchImages?: typeof fetchProductImages;
  /** Injected for tests; defaults to the pixel heuristic in variant-merger (zero tokens). */
  classifyBackground?: (url: string) => Promise<ImageBackground>;
}

/** Rank used to order clean candidates: lifestyle first, white studio packshot last.
 *
 *  `unknown` sits in the MIDDLE on purpose. It means the heuristic could not decide —
 *  a download timeout, an oversize file, a decode failure — and demoting an undecidable
 *  photo below a KNOWN white packshot would let a detection failure silently rewrite the
 *  house rule (pos-1 = lifestyle when one exists, white background otherwise). With every
 *  background unknown the ranks are all equal, the sort is stable, and the scan order is
 *  exactly the gallery order this function replaced — i.e. it degrades to the old behaviour
 *  rather than to a random one. */
const BACKGROUND_RANK: Record<ImageBackground, number> = {
  lifestyle: 0,
  unknown: 1,
  white_bg: 2,
};

/** Can this swap be applied unattended, or does a human have to pick? */
export type SwapDecision = "obvious" | "ambiguous";

/**
 * Below this self-reported confidence, a verdict goes to a human even when the set is
 * otherwise unambiguous. Deliberately low: the model reports ≥0.9 on almost everything, so a
 * value under 0.75 is it actually hedging, not routine variance.
 */
export const MIN_AUTO_CONFIDENCE = 0.75;

/** One clean candidate found during the scan, with everything the decision needs. */
export interface CleanCandidate {
  candidate: AuditCandidate;
  background: ImageBackground;
  reason: string;
  confidence?: number;
}

/**
 * Obvious, or ambiguous?
 *
 * The rule is "is the winner UNIQUE in its class", not "is there only one clean photo in the
 * set". A set holding one lifestyle shot and four packshots is not a coin toss: the coded
 * lifestyle > white_bg preference names a winner, and no human judgement would improve on it.
 * What the preference CANNOT break is a tie inside a class — two different lifestyle photos,
 * or (with no lifestyle at all) several packshots. There the choice is editorial, so it goes
 * to a person.
 *
 * A dirty pos-1 with exactly one clean photo anywhere is the same thing by definition: unique
 * in its class.
 *
 * Confidence overrides both ways: if the model hedged on the pos-1 verdict or on the photo we
 * would promote, a human looks, however clean-cut the set appears. A verdict cached before
 * confidence was kept reports `undefined`, which is NOT low confidence — it is no information,
 * and treating it as a red flag would send the whole legacy cache to the queue.
 */
export function classifySwapDecision(
  clean: CleanCandidate[],
  pos1Confidence?: number,
): { decision: SwapDecision; reason: string } {
  if (clean.length === 0) return { decision: "ambiguous", reason: "aucune alternative propre" };

  const winner = clean[0];
  const lowPos1 = pos1Confidence !== undefined && pos1Confidence < MIN_AUTO_CONFIDENCE;
  const lowWinner = winner.confidence !== undefined && winner.confidence < MIN_AUTO_CONFIDENCE;
  if (lowPos1 || lowWinner) {
    return {
      decision: "ambiguous",
      reason: `confiance faible du classificateur (${lowPos1 ? "verdict pos-1" : "image proposée"} < ${MIN_AUTO_CONFIDENCE})`,
    };
  }

  const rivals = clean.filter((c) => c.background === winner.background).length;
  if (rivals > 1) {
    const label = winner.background === "lifestyle" ? "lifestyle" : winner.background === "white_bg" ? "fond blanc" : "indéterminé";
    return {
      decision: "ambiguous",
      reason: `${rivals} images propres de type « ${label} » — la préférence codée ne tranche pas entre elles`,
    };
  }

  return {
    decision: "obvious",
    reason:
      clean.length === 1
        ? "une seule alternative propre dans tout le jeu d'images"
        : `une seule alternative propre de type « ${winner.background === "lifestyle" ? "lifestyle" : "fond blanc"} », qui l'emporte par la préférence codée`,
  };
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
      const verdict: CachedImageVerdict = { compliant: v.compliant, reason: v.reason, confidence: v.confidence };
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
 * Order the alternatives so the first CLEAN one found is a lifestyle shot when the set holds
 * one, and a white studio packshot otherwise.
 *
 * ── Why an ordering and not a filter ────────────────────────────────────────────────────
 * The house rule is a PREFERENCE ("pos-1 = lifestyle when available, white background
 * otherwise"), never a veto: a clean white packshot at pos-1 beats an overlay at pos-1 every
 * time. Expressed as a sort, the existing "stop at the first clean image" scan yields
 * lifestyle > white_bg > overlay for free, and — this is the point — spends exactly the same
 * number of Claude calls as before. Collecting every clean candidate to rank them afterwards
 * would have cost one vision call per extra image on the daily guard's 20-call budget.
 *
 * Background detection itself is the pixel heuristic from variant-merger: a 100×100 resize
 * and a border-whiteness ratio. It downloads images but spends ZERO tokens, and returns
 * "unknown" on any failure, which the rank above absorbs.
 */
export async function orderByBackgroundPreference(
  alternatives: AuditCandidate[],
  classifyBg: (url: string) => Promise<ImageBackground> = classifyImageBackground,
): Promise<Array<AuditCandidate & { background: ImageBackground }>> {
  const withBg = await Promise.all(
    alternatives.map(async (c) => {
      let background: ImageBackground = "unknown";
      try {
        background = await classifyBg(c.url);
      } catch {
        // classifyImageBackground already swallows its own failures into "unknown"; this
        // guards an injected implementation that throws. Never let background detection —
        // a nice-to-have ordering signal — abort a compliance audit.
        background = "unknown";
      }
      return { ...c, background };
    }),
  );
  // Stable sort: candidates of equal rank keep their gallery order (Shopify positions first,
  // feed-only photos after), exactly as buildCandidates laid them out.
  return withBg
    .map((c, i) => ({ c, i }))
    .sort((a, b) => BACKGROUND_RANK[a.c.background] - BACKGROUND_RANK[b.c.background] || a.i - b.i)
    .map(({ c }) => c);
}

export interface PrimaryImageGuardResult {
  /** The image list to actually create the product with. */
  images: string[];
  /** "clean" | "reordered" | "no_alternative" | "skipped" (no images / classification failed). */
  outcome: "clean" | "reordered" | "no_alternative" | "skipped";
  /** The pos-1 verdict's rationale, for the import log. */
  reason?: string;
  /** Index the promoted photo came from, when `outcome` is "reordered". */
  promotedFrom?: number;
  /** Vision calls spent (cache hits cost nothing). */
  calls: number;
}

/**
 * Import-time guard: never let a marketing/measurement overlay become a NEW product's pos-1.
 *
 * This is the same verdict engine the daily guard uses, moved to the only moment where fixing
 * it is free — before the product exists. Every one of the 312 proposals the catalogue audit
 * produced was a product imported with a dirty pos-1 and corrected weeks later, by which time
 * customers had already seen it. Checking at creation costs the same single vision call and
 * removes the correction entirely.
 *
 * The list is expected PRE-CURATED (`selectProductImagesAsync` has already dropped small
 * images and ordered lifestyle shots first), so the first clean photo found is also the
 * best-looking one.
 *
 * Fails SAFE in every direction: a classification error, an empty list, or a set where every
 * photo carries text all return the list UNCHANGED. The product imports normally and the case
 * is reported for visibility — an import must never be blocked by an image opinion.
 */
export async function enforceCleanPrimaryImage(
  images: string[],
  options: Pick<AuditOptions, "classify" | "classifyOptions" | "useCache"> = {},
): Promise<PrimaryImageGuardResult> {
  if (images.length === 0) return { images, outcome: "skipped", calls: 0 };

  const counters = { calls: 0, cacheHits: 0, lastError: undefined as string | undefined };
  const opts = { useCache: options.useCache ?? true, classify: options.classify, classifyOptions: options.classifyOptions };

  const verdictFor = async (url: string) => {
    const map = await classifyWithCache([url], opts, counters);
    return map.get(imageUrlStem(url));
  };

  const first = await verdictFor(images[0]);
  // No verdict = no evidence. Importing an overlay is a small, correctable harm; refusing to
  // import, or reordering on a guess, is worse.
  if (!first) return { images, outcome: "skipped", reason: counters.lastError, calls: counters.calls };
  if (first.compliant) return { images, outcome: "clean", reason: first.reason, calls: counters.calls };

  for (let i = 1; i < images.length; i++) {
    const v = await verdictFor(images[i]);
    if (!v || !v.compliant) continue;
    const reordered = [images[i], ...images.filter((_, j) => j !== i)];
    return { images: reordered, outcome: "reordered", reason: v.reason, promotedFrom: i, calls: counters.calls };
  }

  return { images, outcome: "no_alternative", reason: first.reason, calls: counters.calls };
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
  // Ordered lifestyle-first (zero tokens) so "first clean" means "best clean": a lifestyle
  // shot when the set holds one, a white studio packshot otherwise. Either beats leaving the
  // overlay at pos-1 — the scan below stops at the first CLEAN image, whatever its
  // background, so a set with nothing but packshots still yields a proposal.
  const rawAlternatives = candidates.filter((c) => imageUrlStem(c.url) !== imageUrlStem(pos1.url));
  const alternatives =
    options.preferLifestyle === false
      ? rawAlternatives.map((c) => ({ ...c, background: "unknown" as ImageBackground }))
      : await orderByBackgroundPreference(rawAlternatives, options.classifyBackground);
  let truncated = false;
  // With `scanAllAlternatives` the loop keeps going past the first clean photo so the whole
  // set is known — the only way to tell "one obvious winner" from "several equal candidates".
  // It costs one vision call per extra image, which is why it is opt-in (hybrid mode) rather
  // than always on: queue mode never needed it, and the daily guard's call budget is small.
  const scanAll = options.scanAllAlternatives === true;
  const clean: CleanCandidate[] = [];

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

    clean.push({ candidate: alt, background: alt.background, reason: v.reason, confidence: v.confidence });
    if (!scanAll) break;
  }

  if (clean.length === 0) {
    return { ...base, status: truncated ? "deferred" : "no_alternative", cleanAlternatives: 0 };
  }

  // `alternatives` was already ordered lifestyle-first, and the scan walks it in order, so the
  // first clean photo found IS the preferred one.
  const winner = clean[0];
  const { decision, reason: decisionReason } = classifySwapDecision(clean, pos1Verdict.confidence);

  return {
    ...base,
    status: "fixable",
    proposedUrl: winner.candidate.url,
    proposedImageId: winner.candidate.imageId,
    proposedPosition: winner.candidate.position,
    proposedReason: winner.reason,
    proposedSource: winner.candidate.source,
    proposedBackground: winner.background,
    cleanAlternatives: clean.length,
    // Without a full scan the count is capped at 1, so a decision would be a guess. Report
    // none rather than a confident-looking "obvious" derived from a partial view.
    ...(scanAll ? { decision, decisionReason } : {}),
  };
}
