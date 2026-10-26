/**
 * Automatic daily catalogue import — selection policy (pure functions, no I/O).
 *
 * Decided with the owner on 2026-10-07:
 *  - 100 groups/day, spread over the day (never one burst that starves other jobs);
 *  - every NEW arrival first (as soon as it shows up in the feed), then every category by share, and inside a
 *    category the products that sell most at the supplier first (`demand`: units that left Aosom's stock in the
 *    last DEMAND_DAYS days, all channels). Changed 2026-10-17: toys used to go first (up to 60/day) but our store
 *    never sold one while kitchen, storage, living room and bathroom sell; toys are now a small share capped at
 *    TOYS_DAILY_CAP;
 *  - only products with a variant holding >= MIN_STOCK units, >= MIN_IMAGES photos and a price >= MIN_PRICE;
 *  - only big sellers (2026-10-17): >= MIN_DEMAND units sold at the supplier in DEMAND_DAYS, or a product type that
 *    already sells on our store;
 *  - no patio unless it is a winter item;
 *  - licensed / third-party brand names (Mercedes-Benz, Disney…) are imported WITHOUT the name: it is stripped from the
 *    copy (`stripLicensedFromContent`) only (a brand visible on a photo is fine; decided 2026-10-15).
 *
 * A "group" is one AosomMergedProduct (all colours/sizes of a PSIN), which is exactly what the
 * import pipeline turns into one Shopify product.
 */
import type { AosomMergedProduct } from "@/types/aosom";
import { computeSellPrice } from "@/lib/sell-price-rule";

export type AutoImportMode = "off" | "dry" | "pilot" | "live";

export const DEFAULT_DAILY_CAP = 100;
/** Pilot: drafts only, a small batch for the owner to eyeball before going live. */
export const PILOT_DAILY_CAP = 10;
export const MIN_STOCK = 10;
export const MIN_IMAGES = 3;
export const MIN_PRICE = 30;
/**
 * Import pricing rules (Mat, 2026-10-15). A product is imported only when:
 *   1. it has a known Aosom price (>= MIN_PRICE) and our cost is known (feed: wholesale + delivery);
 *   2. at the price the sell-price rule will give it (about 20 % margin, a dollar under the competitor), the margin on cost is at
 *      least MIN_IMPORT_MARGIN. Below that, payment fees (~3 %) and the return cost (delivery + 10 %) leave nothing.
 * It is then created AT that price (shopify-client + sell-price-db#priceNewVariants), never at the Aosom price to be raised later.
 * The rules apply only when the feed gave us at least MARGIN_RULES_MIN_COSTS costs; a feed without costs must not block every import.
 */
export const MIN_IMPORT_MARGIN = 0.12;
export const MARGIN_RULES_MIN_COSTS = 1000;
export const TOYS_DAILY_CAP = 10;
/** Supplier sales window used for `demand` (days of stock movements in price_history). */
export const DEMAND_DAYS = 30;
/**
 * Big sellers only (Mat, 2026-10-17): a group is imported when it sold at least MIN_DEMAND units at the supplier over
 * DEMAND_DAYS, or when its exact product type already sold MIN_STORE_TYPE_SALES units on our own store. Applies only
 * when the demand history is loaded (an empty or missing map must not stop every import).
 */
export const MIN_DEMAND = 10;
export const MIN_STORE_TYPE_SALES = 2;
/** Imports are paced across this UTC window (07:00 = right after the 06:00/06:30 feed sync). */
export const WINDOW_START_UTC_HOUR = 7;
export const WINDOW_END_UTC_HOUR = 21;
/** Hard ceiling per cron tick so a tick always fits inside the function's time budget. */
export const MAX_PER_TICK = 3;

export const TOYS = "Toys & Games";
export const PATIO = "Patio & Garden";

/**
 * Share of the daily quota per top-level category; "other" covers everything not listed (holiday, home improvement…).
 * Set 2026-10-17 from what sells: Home Furnishings (kitchen, storage, living room, bathroom) is ~60 % of the supplier's
 * sales outside patio and most of ours; toys 0 sales on our store.
 */
export const CATEGORY_SHARES: Record<string, number> = {
  "Home Furnishings": 0.55,
  "Office Products": 0.12,
  "Pet Supplies": 0.12,
  "Sports & Recreation": 0.06,
  "Toys & Games": 0.05,
  other: 0.1,
};

const WINTER_RE = /\b(snow|winter|sled|sleigh|toboggan|luge|neige|hiver|heater|chauffage|ice\s?fishing)\b/i;
const CHRISTMAS_RE = /\b(christmas|no[eë]l|xmas)\b/i;
/** Third-party / licensed names that must never go out unreviewed. Word-boundary matched. */
const LICENSED_RE =
  /\b(mercedes([- ]benz)?|benz|bmw|audi|ferrari|lamborghini|porsche|maserati|bentley|rolls[- ]royce|tesla|jeep|land rover|range rover|ford|chevrolet|chevy|tahoe|silverado|gmc|dodge|toyota|honda|nissan|mazda|subaru|kia|hyundai|volvo|volkswagen|vw|mclaren|bugatti|aston martin|mini cooper|harley|ducati|aprilia|kawasaki|yamaha|suzuki|ktm|polaris|can-am|john deere|caterpillar|bobcat|disney|marvel|barbie|hot wheels|peppa|paw patrol|bluey|spider-?man|frozen|minnie|mickey|lego|nike|adidas|pokemon|pok[eé]mon|hello kitty|star wars|batman|hulk|avengers|minecraft|fisher[- ]price|little tikes|nerf|hasbro|mattel|playmobil|cocomelon|baby shark|sonic the hedgehog|super mario|nintendo)\b/i;

/** True when the text names a licensed / third-party brand (never auto-published). */
export function isLicensedName(text: string): boolean {
  return LICENSED_RE.test(text);
}

const LICENSED_GLOBAL_RE = new RegExp(LICENSED_RE.source + "(?:[ -]+[A-Za-z]{1,3}\\d{1,3}[A-Za-z]{0,2}\\b)?", "gi");
/** "inspiré de la Mercedes", "inspired by Jeep", "réplique du …": the lead-in goes with the brand so no stub is left. */
const INSPIRED_BY_RE = new RegExp(
  "(?:inspir[ée]e?s?|r[ée]plique|mod[èe]le)\\s+(?:de\\s+la|de\\s+l['’]|du|des|de|d['’])\\s*(?:" + LICENSED_RE.source.replace(/^\\b\(/, "(").replace(/\)\\b$/, ")") + ")(?:[ -]+[A-Za-z]{1,3}\\d{1,3}[A-Za-z]{0,2}\\b)?|(?:inspired by|based on|replica of|modeled on)\\s+" + LICENSED_RE.source + "(?:[ -]+[A-Za-z]{1,3}\\d{1,3}[A-Za-z]{0,2}\\b)?",
  "gi",
);
const LICENSE_PHRASE_RE =
  /\b(?:officially\s+licensed|official\s+licensed|licensed|sous\s+licence(?:\s+officielle)?|licence\s+officielle)\b[\s:,-]*/gi;

/**
 * Remove third-party / licensed brand names (and a trailing model code such as "G63") from one text, then tidy what is left:
 * "licence" wording, doubled spaces, dangling "de/d'/pour/-" and empty "()". Safe on HTML (only text runs are touched).
 */
export function stripLicensedNames(text: string): string {
  if (!text) return text;
  const out = text
    .replace(LICENSE_PHRASE_RE, "")
    .replace(INSPIRED_BY_RE, "")
    .replace(LICENSED_GLOBAL_RE, "")
    .replace(/\b(?:de la|de l['’]|du|des)\s+(?=(?:avec|pour|et|en|à|sur|qui)\b)/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/(^|[>\s])(?:de|du|d'|d’|of|for|pour|with|avec|and|et|-|–|—)\s*(?=[,.;:<]|$)/gi, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/(^|>)\s+/g, "$1")
    .trim();
  return out.replace(/^[a-zà-ÿ]/, (c) => c.toUpperCase());
}

/** The text fields of a generated listing that may carry a brand name. */
const BRAND_TEXT_FIELDS = [
  "titleFr", "titleEn", "descriptionFr", "descriptionEn", "seoDescriptionFr", "seoDescriptionEn",
  "metaTitleFr", "metaTitleEn", "metaDescriptionFr", "metaDescriptionEn",
] as const;

/**
 * Strip licensed names from every customer-facing field (copy, meta, handle, tags). Returns the cleaned content and
 * the list of fields that changed (empty = nothing to strip, content returned untouched).
 */
export function stripLicensedFromContent<T extends Record<string, unknown>>(content: T): { content: T; changed: string[] } {
  const next: Record<string, unknown> = { ...content };
  const changed: string[] = [];
  for (const f of BRAND_TEXT_FIELDS) {
    const v = next[f];
    if (typeof v === "string" && LICENSED_RE.test(v)) {
      next[f] = stripLicensedNames(v);
      changed.push(f);
    }
  }
  for (const f of ["urlHandleFr", "urlHandleEn"] as const) {
    const v = next[f];
    if (typeof v === "string" && LICENSED_RE.test(v.replace(/-/g, " "))) {
      next[f] = v.split("-").filter((w, i, a) => !LICENSED_RE.test(w) && !(i > 0 && LICENSED_RE.test(a[i - 1]) && /\d/.test(w))).join("-");
      changed.push(f);
    }
  }
  if (Array.isArray(next.tags)) {
    const tags = (next.tags as unknown[]).filter((t) => !(typeof t === "string" && LICENSED_RE.test(t)));
    if (tags.length !== (next.tags as unknown[]).length) {
      next.tags = tags;
      changed.push("tags");
    }
  }
  return { content: changed.length ? (next as T) : content, changed };
}

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
  /** Margin on cost at the price the rule will give (0..1) and in dollars; set when the margin rules applied. */
  margin?: number;
  marginDollars?: number;
  /** Units that left the supplier's stock over DEMAND_DAYS, summed over the group's SKUs (0 when unknown). */
  demand?: number;
  /** Units our store sold of products with the same product type. */
  storeTypeSales?: number;
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
  /** SKU -> our unit cost (wholesale + delivery). Margin rules apply when it holds >= MARGIN_RULES_MIN_COSTS entries. */
  costs?: ReadonlyMap<string, number>;
  /** SKU (upper case) -> competitor price, for the price the rule will give. */
  competitor?: ReadonlyMap<string, number>;
  /** SKU -> units that left the supplier's stock over DEMAND_DAYS (see run.ts#loadDemand). */
  demand?: ReadonlyMap<string, number>;
  /** Supplier product type -> units our store sold of that type (see run.ts#loadStoreTypeSales). */
  storeTypeSales?: ReadonlyMap<string, number>;
}

export interface CandidateBuild {
  candidates: Candidate[];
  /** Left out on purpose and worth a human look. */
  flaggedLicensed: string[];
  /** Left out by the import pricing rules, and (lowDemand) by the big-sellers rule. */
  rejected: { noCost: number; lowMargin: number; lowDemand?: number };
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
  const rejected = { noCost: 0, lowMargin: 0, lowDemand: 0 };
  const rulesOn = ctx.costs !== undefined && ctx.costs.size >= MARGIN_RULES_MIN_COSTS;
  const bigSellersOnly = ctx.demand !== undefined && ctx.demand.size > 0;

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

    const demand = skus.reduce((s, sku) => s + (ctx.demand?.get(sku) ?? 0), 0);
    const storeTypeSales = ctx.storeTypeSales?.get(g.productType) ?? 0;
    if (bigSellersOnly && demand < MIN_DEMAND && storeTypeSales < MIN_STORE_TYPE_SALES) { rejected.lowDemand++; continue; }

    // Licensed names are no longer a reason to skip: the copy is generated, then the name is stripped.
    if (LICENSED_RE.test(g.name)) flaggedLicensed.push(g.groupKey);

    let marginInfo: { margin: number; dollars: number } | null = null;
    if (rulesOn) {
      const cheapest = [...stocked].sort((a, b) => a.price - b.price)[0];
      const cost = ctx.costs!.get(cheapest.sku);
      if (!(typeof cost === "number" && cost > 0)) { rejected.noCost++; continue; }
      const rule = computeSellPrice({ aosomPrice: cheapest.price, productType: g.productType, cost, competitorPrice: ctx.competitor?.get(cheapest.sku.toUpperCase()) ?? null });
      const price = Number.isFinite(rule.price) ? rule.price : cheapest.price;
      const margin = (price - cost) / price;
      // A price the profit floor had to push up (above the competitor or the cap) is not a competitive price: too thin.
      if (margin < MIN_IMPORT_MARGIN || rule.reason === "profit") { rejected.lowMargin++; continue; }
      marginInfo = { margin, dollars: price - cost };
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
      demand,
      storeTypeSales,
      ...(marginInfo ? { margin: marginInfo.margin, marginDollars: marginInfo.dollars } : {}),
    });
  }
  return { candidates, flaggedLicensed, rejected };
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
  /** Held only because the supplier photos were unusable (product-specific; not counted by the pause rule). */
  photoHeld?: number;
}

export function emptyState(day: string): DayState {
  return { day, total: 0, toys: 0, byCat: {}, newCount: 0, needsReview: 0, failed: 0, photoHeld: 0 };
}

/** Category bucket used for the share rule: a listed category, or "other". */
export function shareBucket(top: string): string {
  return top in CATEGORY_SHARES && top !== "other" ? top : "other";
}

export function score(c: Candidate): number {
  // Seasonal first, then what sells at the supplier (up to +6,000 for 300 units in DEMAND_DAYS), then supplier depth
  // (a proxy for a product that is staying), a mid price band and the margin (up to +2,000 for 100 $ per unit).
  const priceBand = c.minPrice >= 50 && c.minPrice <= 400 ? 1 : 0;
  return (
    (c.seasonal ? 100_000 : 0) +
    Math.min(c.demand ?? 0, 300) * 20 +
    // Proven on our own store: up to +7,500 for 5 units sold of the same product type.
    Math.min(c.storeTypeSales ?? 0, 5) * 1_500 +
    Math.min(c.totalQty, 2_000) +
    priceBand * 500 +
    Math.min(c.marginDollars ?? 0, 100) * 20
  );
}

/**
 * Pick up to `n` candidates for one tick, honouring: new arrivals first, then every category by its share (largest
 * deficit first, best score first inside it), toys never above TOYS_DAILY_CAP.
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

  // 2) Every category by share deficit; toys stop at their cap.
  const rest = candidates.filter((c) => !taken.has(c.groupKey));
  const byBucket = new Map<string, Candidate[]>();
  for (const c of rest) {
    const b = shareBucket(c.top);
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(c);
  }
  for (const list of byBucket.values()) list.sort((a, b) => score(b) - score(a));
  const countIn = (bucket: string) =>
    Object.entries(state.byCat).filter(([k]) => shareBucket(k) === bucket).reduce((s, [, v]) => s + v, 0) +
    out.filter((c) => shareBucket(c.top) === bucket).length;
  const done = () => state.total + out.length;
  while (out.length < left) {
    let best: string | null = null;
    let bestDeficit = -Infinity;
    for (const [bucket, list] of byBucket) {
      if (list.length === 0) continue;
      if (bucket === TOYS && toysSoFar() >= TOYS_DAILY_CAP) continue;
      const deficit = CATEGORY_SHARES[bucket] * (done() + 1) - countIn(bucket);
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
