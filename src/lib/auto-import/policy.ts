/**
 * Automatic daily catalogue import — selection policy (pure functions, no I/O).
 *
 * Decided with the owner on 2026-10-07:
 *  - 100 groups/day, spread over the day (never one burst that starves other jobs);
 *  - every NEW arrival first (as soon as it shows up in the feed), then toys (as many as possible,
 *    up to TOYS_DAILY_CAP), then the other categories by share;
 *  - only products with a variant holding >= MIN_STOCK units, >= MIN_IMAGES photos and a price >= MIN_PRICE;
 *  - no patio unless it is a winter item;
 *  - licensed / third-party brand names (Mercedes-Benz, Disney…) are never auto-imported: a human decides.
 *
 * A "group" is one AosomMergedProduct (all colours/sizes of a PSIN), which is exactly what the
 * import pipeline turns into one Shopify product.
 */
import type { AosomMergedProduct } from "@/types/aosom";

export type AutoImportMode = "off" | "dry" | "pilot" | "live";

export const DEFAULT_DAILY_CAP = 100;
/** Pilot: drafts only, a small batch for the owner to eyeball before going live. */
export const PILOT_DAILY_CAP = 10;
export const MIN_STOCK = 10;
export const MIN_IMAGES = 3;
export const MIN_PRICE = 30;
export const TOYS_DAILY_CAP = 60;
/** Imports are paced across this UTC window (07:00 = right after the 06:00/06:30 feed sync). */
export const WINDOW_START_UTC_HOUR = 7;
export const WINDOW_END_UTC_HOUR = 21;
/** Hard ceiling per cron tick so a tick always fits inside the function's time budget. */
export const MAX_PER_TICK = 3;

export const TOYS = "Toys & Games";
export const PATIO = "Patio & Garden";

/** Share of the NON-toy quota per top-level category; "other" covers everything not listed. */
export const CATEGORY_SHARES: Record<string, number> = {
  "Home Furnishings": 0.35,
  "Pet Supplies": 0.28,
  "Sports & Recreation": 0.18,
  "Office Products": 0.1,
  other: 0.09,
};

const WINTER_RE = /\b(snow|winter|sled|sleigh|toboggan|luge|neige|hiver|heater|chauffage|ice\s?fishing)\b/i;
const CHRISTMAS_RE = /\b(christmas|no[eë]l|xmas)\b/i;
/** Third-party / licensed names that must never go out unreviewed. Word-boundary matched. */
const LICENSED_RE =
  /\b(mercedes(-benz)?|bmw|audi|ferrari|lamborghini|porsche|maserati|bentley|rolls[- ]royce|tesla|jeep|land rover|ford|chevrolet|toyota|honda|harley|ducati|disney|marvel|barbie|hot wheels|peppa|paw patrol|bluey|spider-?man|frozen|minnie|mickey|lego|nike|adidas|pokemon|pok[eé]mon|hello kitty|star wars|batman|hulk|avengers|minecraft)\b/i;

export interface Candidate {
  groupKey: string;
  skus: string[];
  name: string;
  productType: string;
  top: string;
  minPrice: number;
  totalQty: number;
  imageCount: number;
  isNew: boolean;
  seasonal: boolean;
}

export interface CandidateContext {
  /** SKUs that already have a Shopify product. */
  importedSkus: ReadonlySet<string>;
  /** First time a SKU was seen in the feed (unix seconds). */
  firstSeen: ReadonlyMap<string, number>;
  /** group_key → latest import job status, for groups that already have a job. */
  jobs: ReadonlyMap<string, { status: string; updatedAt: string }>;
  now: Date;
  /** A SKU first seen less than this many days ago counts as a new arrival. */
  newDays?: number;
}

export interface CandidateBuild {
  candidates: Candidate[];
  /** Left out on purpose and worth a human look. */
  flaggedLicensed: string[];
}

export function topCategory(productType: string): string {
  return (productType || "").split(">")[0].trim();
}

/** True when the date falls in the Christmas run-up (until Dec 10) or the winter-sports season. */
export function isSeasonal(name: string, productType: string, now: Date): boolean {
  const text = `${name} ${productType}`;
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const christmasWindow = (month >= 10 && month <= 11) || (month === 12 && day <= 10);
  if (christmasWindow && CHRISTMAS_RE.test(text)) return true;
  const winterWindow = month >= 11 || month <= 2;
  return winterWindow && WINTER_RE.test(text);
}

/** Job statuses that mean "this group is in someone's hands already" — never re-select. */
const BLOCKING_JOB = new Set(["pending", "generating", "reviewing", "importing", "done", "already_imported", "needs_review"]);
const ERROR_RETRY_HOURS = 24;

export function buildCandidates(catalog: AosomMergedProduct[], ctx: CandidateContext): CandidateBuild {
  const newDays = ctx.newDays ?? 14;
  const newCutoff = Math.floor(ctx.now.getTime() / 1000) - newDays * 86400;
  const flaggedLicensed: string[] = [];
  const candidates: Candidate[] = [];

  for (const g of catalog) {
    const skus = g.variants.map((v) => v.sku);
    if (skus.length === 0 || skus.some((s) => ctx.importedSkus.has(s))) continue;

    const job = ctx.jobs.get(g.groupKey);
    if (job) {
      if (BLOCKING_JOB.has(job.status)) continue;
      if (job.status === "error") {
        const ageH = (ctx.now.getTime() - new Date(job.updatedAt).getTime()) / 3_600_000;
        if (!(ageH >= ERROR_RETRY_HOURS)) continue;
      }
    }

    const stocked = g.variants.filter((v) => v.qty > 0);
    if (!stocked.some((v) => v.qty >= MIN_STOCK)) continue;
    if ((g.images?.length ?? 0) < MIN_IMAGES) continue;
    const minPrice = Math.min(...g.variants.map((v) => v.price).filter((p) => p > 0));
    if (!Number.isFinite(minPrice) || minPrice < MIN_PRICE) continue;

    const top = topCategory(g.productType);
    const seasonal = isSeasonal(g.name, g.productType, ctx.now);
    if (top === PATIO && !WINTER_RE.test(`${g.name} ${g.productType}`) && !CHRISTMAS_RE.test(`${g.name} ${g.productType}`)) continue;

    if (LICENSED_RE.test(g.name)) {
      flaggedLicensed.push(g.groupKey);
      continue;
    }

    const seen = skus.map((s) => ctx.firstSeen.get(s)).filter((t): t is number => typeof t === "number");
    const isNew = seen.length > 0 && Math.min(...seen) >= newCutoff;

    candidates.push({
      groupKey: g.groupKey,
      skus: stocked.map((v) => v.sku),
      name: g.name,
      productType: g.productType,
      top,
      minPrice,
      totalQty: stocked.reduce((s, v) => s + v.qty, 0),
      imageCount: g.images.length,
      isNew,
      seasonal,
    });
  }
  return { candidates, flaggedLicensed };
}

export interface DayState {
  /** Montréal calendar date the counters belong to. */
  day: string;
  total: number;
  toys: number;
  byCat: Record<string, number>;
  newCount: number;
  needsReview: number;
  failed: number;
}

export function emptyState(day: string): DayState {
  return { day, total: 0, toys: 0, byCat: {}, newCount: 0, needsReview: 0, failed: 0 };
}

/** Category bucket used for the share rule: a listed category, or "other". */
export function shareBucket(top: string): string {
  return top in CATEGORY_SHARES && top !== "other" ? top : "other";
}

function score(c: Candidate): number {
  // Seasonal first, then supplier depth (a proxy for a product that is staying), then a mid price band.
  const priceBand = c.minPrice >= 50 && c.minPrice <= 400 ? 1 : 0;
  return (c.seasonal ? 100_000 : 0) + Math.min(c.totalQty, 2_000) + priceBand * 500;
}

/**
 * Pick up to `n` candidates for one tick, honouring: new arrivals first, then toys up to the
 * toy cap, then the other categories by their share (largest deficit first).
 */
export function pickBatch(candidates: Candidate[], state: DayState, n: number, dailyCap: number): Candidate[] {
  const left = Math.max(0, Math.min(n, dailyCap - state.total));
  if (left === 0) return [];
  const taken = new Set<string>();
  const out: Candidate[] = [];
  const toysSoFar = () => state.toys + out.filter((c) => c.top === TOYS).length;
  const take = (c: Candidate) => {
    taken.add(c.groupKey);
    out.push(c);
  };

  // 1) New arrivals (all categories; toys among them still respect the toy cap).
  const fresh = candidates.filter((c) => c.isNew).sort((a, b) => score(b) - score(a));
  for (const c of fresh) {
    if (out.length >= left) break;
    if (c.top === TOYS && toysSoFar() >= TOYS_DAILY_CAP) continue;
    take(c);
  }

  // 2) Toys, as many as the cap allows.
  const toys = candidates.filter((c) => c.top === TOYS && !taken.has(c.groupKey)).sort((a, b) => score(b) - score(a));
  for (const c of toys) {
    if (out.length >= left) break;
    if (toysSoFar() >= TOYS_DAILY_CAP) break;
    take(c);
  }

  // 3) Everything else by share deficit.
  const rest = candidates.filter((c) => c.top !== TOYS && !taken.has(c.groupKey));
  const byBucket = new Map<string, Candidate[]>();
  for (const c of rest) {
    const b = shareBucket(c.top);
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(c);
  }
  for (const list of byBucket.values()) list.sort((a, b) => score(b) - score(a));
  const countIn = (bucket: string) =>
    Object.entries(state.byCat).filter(([k]) => shareBucket(k) === bucket).reduce((s, [, v]) => s + v, 0) +
    out.filter((c) => c.top !== TOYS && shareBucket(c.top) === bucket).length;
  const nonToyDone = () => state.total - state.toys + out.filter((c) => c.top !== TOYS).length;
  while (out.length < left) {
    let best: string | null = null;
    let bestDeficit = -Infinity;
    for (const [bucket, list] of byBucket) {
      if (list.length === 0) continue;
      const deficit = CATEGORY_SHARES[bucket] * (nonToyDone() + 1) - countIn(bucket);
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        best = bucket;
      }
    }
    if (best === null) break;
    take(byBucket.get(best)!.shift()!);
  }
  return out;
}

/**
 * How many imports the day's pace allows by `now` (UTC). Nothing before the window opens, the full
 * cap once it closes, linear in between — this is what spreads 100 imports over the day.
 */
export function allowedSoFar(now: Date, dailyCap: number): number {
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (h < WINDOW_START_UTC_HOUR) return 0;
  if (h >= WINDOW_END_UTC_HOUR) return dailyCap;
  const frac = (h - WINDOW_START_UTC_HOUR) / (WINDOW_END_UTC_HOUR - WINDOW_START_UTC_HOUR);
  return Math.min(dailyCap, Math.ceil(dailyCap * frac) + 1);
}

export function parseMode(raw: string | null | undefined): AutoImportMode {
  return raw === "dry" || raw === "pilot" || raw === "live" ? raw : "off";
}
