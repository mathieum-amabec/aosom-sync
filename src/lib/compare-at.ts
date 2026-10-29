/**
 * Compare-at ("Ancien prix") sync — shows a struck-through previous price as soon as a product's price sits 10 %
 * or more below a price it really held, whatever path the new price took to reach Shopify.
 *
 * WHY A SEPARATE JOB (diagnosis 2026-10-14): the price writers only look at the LAST step
 * (`updateShopifyVariantPrice`: oldPrice vs price), so
 *   - a slide in small steps (53.99 -> 48.99 -> 45.99, each < 10 %) never shows a crossed price although the total
 *     is 15 %: 35 of 67 missing displays;
 *   - a price re-written later (price == oldPrice) clears the field;
 *   - 32 products with a single drop >= 10 % still had none.
 * This job derives the field from `price_history`, per product, independent of how the price arrived.
 *
 * REFERENCE RULE (Mat, 2026-10-14): the highest price the product held for at least 14 days within the last 90 days,
 * shown when the current price is 10 % or more below it. The label on the storefront is "Ancien prix" — true for any
 * drop, with no claim of being the ordinary price.
 *
 * Pure functions + dependency-injected orchestrator, like price-reconcile.ts. LIMIT: `price_history` is the AOSOM
 * price history. While our price equals the Aosom price (markup off) that is our price history; when the sell-price
 * rule goes live this must read our own sell-price history instead.
 */
import { SYNC } from "@/lib/config";
import { effectiveSellPrice } from "@/lib/pricing";

export const COMPARE_AT_MODE_KEY = "compare_at_mode";
export const COMPARE_AT_PLAN_KEY = "compare_at_last_plan";
export type CompareAtMode = "off" | "dry" | "live";

export const REFERENCE_MIN_DAYS = 14;
export const REFERENCE_WINDOW_DAYS = 90;
/**
 * Override of REFERENCE_MIN_DAYS (days, 1..90). Mat, 2026-10-28, on his lawyer's advice: the prices raised on
 * 2026-10-15..28 may be shown crossed out once they come back down, even when held only a few days.
 */
export const COMPARE_AT_MIN_DAYS_KEY = "compare_at_min_days";

export function parseMinDays(raw: string | null): number {
  const n = Number(raw);
  return raw !== null && raw.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= REFERENCE_WINDOW_DAYS ? n : REFERENCE_MIN_DAYS;
}
/** Safety valve: Shopify writes per run (about 2 req/s). A first run adds ~100; a normal day a handful. */
export const MAX_WRITES_PER_RUN = 300;
/** A variant listing smaller than this is treated as truncated; the run changes nothing. */
export const MIN_VARIANTS_SEEN = 500;

const DAY = 86_400;
const EPS = 0.005;

export function parseCompareAtMode(raw: string | null): CompareAtMode {
  return raw === "dry" || raw === "live" ? raw : "off";
}

export interface PriceStep {
  oldPrice: number;
  newPrice: number;
  /** Epoch seconds the change was detected. */
  at: number;
}

export interface ReferenceOpts {
  minDays?: number;
  windowDays?: number;
  /** Fraction, e.g. 0.10. Defaults to the shared MIN_DISCOUNT_DISPLAY_PERCENT. */
  minDiscount?: number;
}

/**
 * The previous price to show crossed out, or null. `steps` are the product's price changes (no-op rows are ignored);
 * `firstSeenAt` is when the product first entered the catalogue (start of the first price segment).
 */
export function referencePrice(
  currentPrice: number,
  steps: PriceStep[],
  firstSeenAt: number | null,
  nowS: number,
  opts: ReferenceOpts = {},
): number | null {
  const minDays = opts.minDays ?? REFERENCE_MIN_DAYS;
  const windowDays = opts.windowDays ?? REFERENCE_WINDOW_DAYS;
  const minDiscount = opts.minDiscount ?? SYNC.MIN_DISCOUNT_DISPLAY_PERCENT / 100;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

  const real = steps
    .filter((s) => Number.isFinite(s.oldPrice) && Number.isFinite(s.newPrice) && s.oldPrice > 0 && s.newPrice > 0 && Math.abs(s.oldPrice - s.newPrice) > EPS)
    .sort((a, b) => a.at - b.at);
  if (real.length === 0) return null;

  // Segments of constant price: [from, to). The first starts when the product was first seen; if that is unknown the
  // first segment cannot be proven and is skipped.
  const segments: Array<{ price: number; from: number; to: number }> = [];
  if (firstSeenAt !== null) segments.push({ price: real[0].oldPrice, from: Math.min(firstSeenAt, real[0].at), to: real[0].at });
  real.forEach((s, i) => segments.push({ price: s.newPrice, from: s.at, to: i + 1 < real.length ? real[i + 1].at : nowS }));

  const windowStart = nowS - windowDays * DAY;
  let ref: number | null = null;
  for (const seg of segments) {
    if (seg.price <= currentPrice + EPS) continue;
    const days = (Math.min(seg.to, nowS) - Math.max(seg.from, windowStart)) / DAY;
    if (days >= minDays && (ref === null || seg.price > ref)) ref = seg.price;
  }
  if (ref === null) return null;
  return (ref - currentPrice) / ref >= minDiscount - 1e-9 ? ref : null;
}

export interface LiveVariant {
  sku: string;
  variantId: string;
  price: number;
  compareAtPrice: number | null;
}
export interface PriceSource {
  /** The price Shopify is expected to show (our sell price once set, the Aosom price before). */
  dbPrice: number;
  steps: PriceStep[];
  firstSeenAt: number | null;
}

/** One change of OUR sell price (`sell_price_history`). `oldPrice` is null for the first one. */
export interface SellStep {
  oldPrice: number | null;
  newPrice: number;
  aosomPrice: number | null;
  at: number;
}

/**
 * Turns an Aosom-price source into a source for the price WE display. Once the sell-price rule is live our price is no
 * longer the Aosom price: the expected Shopify price is the sell price (otherwise every marked-up variant looks like a
 * "drift" and is skipped), and the history the reference is taken from is ours — the Aosom steps up to our first sell
 * price, then our own sell-price steps. A markup is therefore never mistaken for a price the customer once paid.
 */
export function displayedPriceSource(aosom: PriceSource, sellPrice: number | null, sellSteps: SellStep[]): PriceSource {
  const expected = effectiveSellPrice(aosom.dbPrice, sellPrice);
  const dbPrice = Number.isFinite(expected) ? expected : aosom.dbPrice;
  const own = sellSteps.filter((s) => Number.isFinite(s.newPrice) && s.newPrice > 0).sort((a, b) => a.at - b.at);
  if (own.length === 0) return { ...aosom, dbPrice };
  const steps: PriceStep[] = aosom.steps.filter((s) => s.at < own[0].at);
  for (const s of own) {
    const before = s.oldPrice ?? s.aosomPrice;
    if (before !== null && Number.isFinite(before) && before > 0) steps.push({ oldPrice: before, newPrice: s.newPrice, at: s.at });
  }
  return { ...aosom, dbPrice, steps };
}
export type CompareAtAction = "set" | "clear";
export interface CompareAtChange {
  sku: string;
  variantId: string;
  action: CompareAtAction;
  from: number | null;
  to: number | null;
  price: number;
}
export interface CompareAtPlan {
  changes: CompareAtChange[];
  keptValid: number;
  noHistory: number;
  /** Shopify price differs from the database price: the price reconcile will fix it first, so we wait. */
  skippedDrift: number;
  alreadyRight: number;
}

const validCrossed = (compareAt: number | null, price: number, minDiscount: number): boolean =>
  compareAt !== null && compareAt > price && (compareAt - price) / compareAt >= minDiscount - 1e-9;

export function planCompareAt(live: LiveVariant[], sources: Map<string, PriceSource>, nowS: number, opts: ReferenceOpts = {}): CompareAtPlan {
  const minDiscount = opts.minDiscount ?? SYNC.MIN_DISCOUNT_DISPLAY_PERCENT / 100;
  const plan: CompareAtPlan = { changes: [], keptValid: 0, noHistory: 0, skippedDrift: 0, alreadyRight: 0 };
  for (const v of live) {
    const src = sources.get(v.sku);
    if (!src) { plan.noHistory++; continue; }
    if (Math.abs(v.price - src.dbPrice) > 0.01) { plan.skippedDrift++; continue; }
    const desired = referencePrice(v.price, src.steps, src.firstSeenAt, nowS, opts);
    const hasValid = validCrossed(v.compareAtPrice, v.price, minDiscount);
    if (desired === null) {
      if (v.compareAtPrice !== null && !hasValid) plan.changes.push({ sku: v.sku, variantId: v.variantId, action: "clear", from: v.compareAtPrice, to: null, price: v.price });
      else if (hasValid) plan.keptValid++;
      else plan.alreadyRight++;
      continue;
    }
    if (hasValid) { plan.keptValid++; continue; } // never overwrite an already-valid crossed price
    plan.changes.push({ sku: v.sku, variantId: v.variantId, action: "set", from: v.compareAtPrice, to: desired, price: v.price });
  }
  return plan;
}

export interface CompareAtDeps {
  now(): Date;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  loadLiveVariants(): Promise<LiveVariant[]>;
  loadSources(): Promise<Map<string, PriceSource>>;
  writeCompareAt(variantId: string, value: number | null): Promise<void>;
}

export interface CompareAtResult {
  mode: CompareAtMode;
  skipped?: string;
  variantsSeen: number;
  plan: CompareAtPlan;
  applied: number;
  failed: number;
  deferred: number;
}

const emptyPlan = (): CompareAtPlan => ({ changes: [], keptValid: 0, noHistory: 0, skippedDrift: 0, alreadyRight: 0 });

export async function runCompareAtSync(opts: { deps: CompareAtDeps; mode?: CompareAtMode; persistPlan?: boolean }): Promise<CompareAtResult> {
  const d = opts.deps;
  const mode = opts.mode ?? parseCompareAtMode(await d.getSetting(COMPARE_AT_MODE_KEY));
  const base: CompareAtResult = { mode, variantsSeen: 0, plan: emptyPlan(), applied: 0, failed: 0, deferred: 0 };
  if (mode === "off") return { ...base, skipped: "off" };

  const live = await d.loadLiveVariants();
  if (live.length < MIN_VARIANTS_SEEN) return { ...base, variantsSeen: live.length, skipped: `listing-incomplete:${live.length}` };
  const sources = await d.loadSources();
  const now = d.now();
  const minDays = parseMinDays(await d.getSetting(COMPARE_AT_MIN_DAYS_KEY));
  const plan = planCompareAt(live, sources, Math.floor(now.getTime() / 1000), { minDays });
  const result: CompareAtResult = { ...base, variantsSeen: live.length, plan };

  if (mode === "dry") {
    if (opts.persistPlan !== false) {
      await d.setSetting(COMPARE_AT_PLAN_KEY, JSON.stringify({ at: now.toISOString(), set: plan.changes.filter((c) => c.action === "set").length, clear: plan.changes.filter((c) => c.action === "clear").length, sample: plan.changes.slice(0, 40) }));
    }
    return { ...result, skipped: "dry-run" };
  }

  const todo = plan.changes.slice(0, MAX_WRITES_PER_RUN);
  result.deferred = plan.changes.length - todo.length;
  for (const c of todo) {
    try {
      await d.writeCompareAt(c.variantId, c.to);
      result.applied++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
