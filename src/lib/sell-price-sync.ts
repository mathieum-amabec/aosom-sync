/**
 * Sell-price sync: turns the pure rule (sell-price-rule.ts) into a stored `products.sell_price` per SKU that every price
 * writer and checker reads (diff-engine, product creation, hourly reconcile, post-sync sample).
 *
 * Controlled by `settings.pricing_mode` = off | dry | live (default off). Off: nothing is stored and every reader
 * falls back to the Aosom price (see `effectiveSellPrice` in pricing.ts), i.e. today's behaviour. Dry: the plan is
 * computed and summarised in `pricing_last_plan`, nothing stored. Live: `sell_price` is written.
 *
 * Stability rules, so prices do not flutter:
 *   - an unset price, or one under the Aosom floor, is always set;
 *   - a LOWER price is followed at once (we stay under the competitor, and an Aosom drop is passed on);
 *   - a HIGHER price is only taken for a meaningful gain (>= max(2 $, 2 %)).
 * A per-run cap (`pricing_max_changes_per_run`, default 500) rolls a large change out over several days; floor fixes
 * come first, then decreases, then the biggest increases.
 */
import { computeSellPrice, roundDownTo99, type SellPriceReason } from "@/lib/sell-price-rule";
import { targetSellPrice } from "@/lib/pricing";

export const PRICING_MODE_KEY = "pricing_mode";
export const PRICING_PLAN_KEY = "pricing_last_plan";
export const PRICING_MAX_CHANGES_KEY = "pricing_max_changes_per_run";
export const DEFAULT_MAX_CHANGES = 500;
export type PricingMode = "off" | "dry" | "live";

export function parsePricingMode(raw: string | null): PricingMode {
  return raw === "dry" || raw === "live" ? raw : "off";
}

/** Meaningful gain needed before a stored price is raised. */
const RAISE_MIN_DOLLARS = 2;
const RAISE_MIN_FRACTION = 0.02;

export function shouldUpdateSellPrice(current: number | null, next: number, floor: number): boolean {
  if (current === null || !Number.isFinite(current)) return true;
  if (current < floor - 0.005) return true;
  if (Math.abs(next - current) < 0.005) return false;
  if (next < current) return true;
  return next - current >= Math.max(RAISE_MIN_DOLLARS, current * RAISE_MIN_FRACTION);
}

/**
 * Highest sell price that keeps every discount worth protecting: for each reference price (a real previous price,
 * or the crossed price currently shown on the storefront), the price must stay at least (1 - keep) below it. A
 * reference only counts when the Aosom price itself was already that far below it (else there is no discount to lose
 * to our markup). Null when nothing needs protecting.
 */
export function discountCap(aosomPrice: number, refs: ReadonlyArray<number | null | undefined>, keep: number): number | null {
  let cap: number | null = null;
  for (const ref of refs) {
    if (ref == null || !Number.isFinite(ref) || ref <= 0) continue;
    if (aosomPrice > ref * keep + 0.005) continue;
    const c = ref * keep;
    cap = cap === null ? c : Math.min(cap, c);
  }
  return cap;
}

export interface SellPriceRow {
  sku: string;
  /** The Aosom price (products.price). */
  aosomPrice: number;
  productType: string;
  /** The stored sell price, if any. */
  sellPrice: number | null;
  /**
   * Highest price that still keeps a real discount of 10 % against the product's reference price (compare-at.ts), when it
   * has one. A markup is never allowed above it, so a product on "Liquidation" does not lose its discount to our own price rise.
   */
  maxPrice?: number | null;
}

export interface SellPriceChange {
  sku: string;
  from: number | null;
  to: number;
  aosomPrice: number;
  reason: SellPriceReason;
}

export interface SellPricePlan {
  changes: SellPriceChange[];
  /** Changes beyond the per-run cap, to be done on later runs. */
  deferred: number;
  unchanged: number;
  invalid: number;
  competitorIgnored: number;
  byReason: Record<string, number>;
}

export function planSellPrices(
  rows: SellPriceRow[],
  competitor: ReadonlyMap<string, number> | null,
  maxChanges: number = DEFAULT_MAX_CHANGES,
): SellPricePlan {
  const all: SellPriceChange[] = [];
  const plan: SellPricePlan = { changes: [], deferred: 0, unchanged: 0, invalid: 0, competitorIgnored: 0, byReason: {} };
  for (const r of rows) {
    const floor = targetSellPrice(r.aosomPrice);
    if (!Number.isFinite(floor)) { plan.invalid++; continue; }
    const res = computeSellPrice({ aosomPrice: r.aosomPrice, productType: r.productType, competitorPrice: competitor?.get(r.sku.toUpperCase()) ?? null });
    if (!Number.isFinite(res.price)) { plan.invalid++; continue; }
    if (r.maxPrice != null && Number.isFinite(r.maxPrice) && res.price > r.maxPrice) {
      // Keep the discount: never above maxPrice, never below the Aosom floor.
      res.price = Math.max(floor, roundDownTo99(r.maxPrice));
      res.reason = res.price <= floor ? "floor" : res.reason;
    }
    if (res.competitorIgnored) plan.competitorIgnored++;
    // Without any competitor data, keep what we have: only unset or under-floor products get a (tier) price.
    if (competitor === null && r.sellPrice !== null && r.sellPrice >= floor - 0.005) { plan.unchanged++; continue; }
    if (!shouldUpdateSellPrice(r.sellPrice, res.price, floor)) { plan.unchanged++; continue; }
    all.push({ sku: r.sku, from: r.sellPrice, to: res.price, aosomPrice: r.aosomPrice, reason: res.reason });
  }
  // Priority: under-floor / unset first, then decreases, then the largest increases.
  const rank = (c: SellPriceChange): number => {
    const floor = targetSellPrice(c.aosomPrice);
    if (c.from === null || c.from < floor - 0.005) return 0;
    return c.to < c.from ? 1 : 2;
  };
  all.sort((a, b) => rank(a) - rank(b) || (b.to - (b.from ?? b.aosomPrice)) - (a.to - (a.from ?? a.aosomPrice)));
  plan.changes = all.slice(0, Math.max(0, maxChanges));
  plan.deferred = all.length - plan.changes.length;
  for (const c of plan.changes) plan.byReason[c.reason] = (plan.byReason[c.reason] ?? 0) + 1;
  return plan;
}

export interface CompetitorSnapshot {
  prices: ReadonlyMap<string, number> | null;
  source: "fresh" | "cache" | "none";
}

export interface SellPriceDeps {
  now(): Date;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  loadRows(): Promise<SellPriceRow[]>;
  loadCompetitor(): Promise<CompetitorSnapshot>;
  /** Persist the new prices and one history row each. */
  saveChanges(changes: SellPriceChange[], at: Date): Promise<void>;
}

export interface SellPriceResult {
  mode: PricingMode;
  skipped?: string;
  competitorSource: CompetitorSnapshot["source"];
  plan: SellPricePlan;
  applied: number;
}

const emptyPlan = (): SellPricePlan => ({ changes: [], deferred: 0, unchanged: 0, invalid: 0, competitorIgnored: 0, byReason: {} });

export async function runSellPriceSync(opts: { deps: SellPriceDeps; mode?: PricingMode; persistPlan?: boolean }): Promise<SellPriceResult> {
  const d = opts.deps;
  const mode = opts.mode ?? parsePricingMode(await d.getSetting(PRICING_MODE_KEY));
  const base: SellPriceResult = { mode, competitorSource: "none", plan: emptyPlan(), applied: 0 };
  if (mode === "off") return { ...base, skipped: "off" };

  const capSetting = Number(await d.getSetting(PRICING_MAX_CHANGES_KEY));
  const maxChanges = Number.isFinite(capSetting) && capSetting > 0 ? Math.floor(capSetting) : DEFAULT_MAX_CHANGES;
  const [rows, comp] = await Promise.all([d.loadRows(), d.loadCompetitor()]);
  if (rows.length === 0) return { ...base, skipped: "no-products" };
  const plan = planSellPrices(rows, comp.prices, maxChanges);
  const now = d.now();
  const result: SellPriceResult = { ...base, competitorSource: comp.source, plan };

  if (mode === "dry") {
    if (opts.persistPlan !== false) {
      await d.setSetting(PRICING_PLAN_KEY, JSON.stringify({ at: now.toISOString(), changes: plan.changes.length, deferred: plan.deferred, byReason: plan.byReason, competitor: comp.source, sample: plan.changes.slice(0, 40) }));
    }
    return { ...result, skipped: "dry-run" };
  }
  if (plan.changes.length > 0) await d.saveChanges(plan.changes, now);
  return { ...result, applied: plan.changes.length };
}
