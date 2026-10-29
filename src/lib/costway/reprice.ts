/**
 * Daily Costway repricing (Mat, 2026-10-29: "fait tourner les prix automatiquement … si un prix est en baisse, les
 * rabais sont affichés").
 *
 * 1. Every Costway variant on Shopify is put at the current rule (pricing.ts: Costway's own price, x.99, never below
 *    it nor its Price Drop). Each change is written to `sell_price_history` (sku = our internal SKU) so the crossed
 *    price can be derived from OUR history.
 * 2. The crossed price ("Ancien prix") is then set by the same rule as the Aosom catalogue (compare-at.ts: the highest
 *    price held >= `compare_at_min_days` within 90 days, shown when the price is >= 10 % below it). The store-wide
 *    compare-at sync skips Costway products (fetchShopifyVariantsPage), so this job runs it on Costway variants itself.
 *
 * Controlled by `settings.costway_reprice_mode` = off | dry | live (default off). Pure planner + injected deps.
 */
import { costwaySellPrice } from "./pricing";
import { runCompareAtSync, type CompareAtDeps, type CompareAtResult, type LiveVariant, type PriceSource, type PriceStep } from "@/lib/compare-at";

export const COSTWAY_REPRICE_MODE_KEY = "costway_reprice_mode";
export type CostwayRepriceMode = "off" | "dry" | "live";
/** Safety valve: Shopify price writes per run (about 2 req/s). */
export const MAX_PRICE_WRITES_PER_RUN = 400;
/** A cut deeper than this is held back as a probable feed error (reported, not written). */
export const MAX_CUT = 0.5;

export function parseRepriceMode(raw: string | null): CostwayRepriceMode {
  return raw === "dry" || raw === "live" ? raw : "off";
}

export interface CostwayRow {
  sku: string;
  internalSku: string;
  shopifyProductId: string;
  price: number;
  priceDrop: number | null;
  promoTag: string;
}

export interface PriceChange {
  sku: string;
  internalSku: string;
  variantId: string;
  from: number;
  to: number;
  costwayPrice: number;
}

export interface RepricePlan {
  changes: PriceChange[];
  same: number;
  /** Rows whose variant is not on Shopify (deleted variant, unpublished product). */
  missing: number;
  /** Unusable feed price (0 / NaN). */
  invalid: number;
  /** Cuts deeper than MAX_CUT, held back. */
  suspicious: PriceChange[];
}

export function planReprice(rows: CostwayRow[], live: Map<string, LiveVariant>): RepricePlan {
  const plan: RepricePlan = { changes: [], same: 0, missing: 0, invalid: 0, suspicious: [] };
  for (const r of rows) {
    const v = live.get(r.internalSku);
    if (!v) { plan.missing++; continue; }
    const next = costwaySellPrice({ price: r.price, priceDrop: r.priceDrop, promoTag: r.promoTag });
    if (!Number.isFinite(next)) { plan.invalid++; continue; }
    if (Math.abs(next - v.price) < 0.005) { plan.same++; continue; }
    const c: PriceChange = { sku: r.sku, internalSku: r.internalSku, variantId: v.variantId, from: v.price, to: next, costwayPrice: r.price };
    if (next < v.price * (1 - MAX_CUT)) plan.suspicious.push(c);
    else plan.changes.push(c);
  }
  return plan;
}

export interface CostwayRepriceDeps {
  now(): Date;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  loadRows(): Promise<CostwayRow[]>;
  /** Live Shopify variants of the given products, keyed by SKU. */
  loadLive(productIds: string[]): Promise<LiveVariant[]>;
  writePrice(variantId: string, price: number): Promise<void>;
  /** Persist one applied change: costway_products.sell_price + a sell_price_history row. */
  recordChange(c: PriceChange, atS: number): Promise<void>;
  /** Price history of our Costway prices, keyed by internal SKU (for the crossed price). */
  loadSources(rows: CostwayRow[], live: LiveVariant[]): Promise<Map<string, PriceSource>>;
  writeCompareAt(variantId: string, value: number | null): Promise<void>;
}

export interface CostwayRepriceResult {
  mode: CostwayRepriceMode;
  skipped?: string;
  plan: RepricePlan;
  applied: number;
  failed: number;
  deferred: number;
  compareAt: CompareAtResult | null;
}

const emptyPlan = (): RepricePlan => ({ changes: [], same: 0, missing: 0, invalid: 0, suspicious: [] });

export async function runCostwayReprice(opts: { deps: CostwayRepriceDeps; mode?: CostwayRepriceMode }): Promise<CostwayRepriceResult> {
  const d = opts.deps;
  const mode = opts.mode ?? parseRepriceMode(await d.getSetting(COSTWAY_REPRICE_MODE_KEY));
  const base: CostwayRepriceResult = { mode, plan: emptyPlan(), applied: 0, failed: 0, deferred: 0, compareAt: null };
  if (mode === "off") return { ...base, skipped: "off" };

  const rows = await d.loadRows();
  if (rows.length === 0) return { ...base, skipped: "no-rows" };
  const live = await d.loadLive([...new Set(rows.map((r) => r.shopifyProductId))]);
  const bySku = new Map(live.map((v) => [v.sku, v]));
  const plan = planReprice(rows, bySku);
  const result: CostwayRepriceResult = { ...base, plan };
  if (mode === "dry") return { ...result, skipped: "dry-run" };

  const todo = plan.changes.slice(0, MAX_PRICE_WRITES_PER_RUN);
  result.deferred = plan.changes.length - todo.length;
  const atS = Math.floor(d.now().getTime() / 1000);
  for (const c of todo) {
    try {
      await d.writePrice(c.variantId, c.to);
      await d.recordChange(c, atS);
      const v = bySku.get(c.internalSku);
      if (v) v.price = c.to;
      result.applied++;
    } catch {
      result.failed++;
    }
  }

  // The crossed price, on the prices now live. Mode comes from compare_at_mode, like the store-wide sync.
  const ours = new Set(rows.map((r) => r.internalSku));
  const costwayLive = live.filter((v) => ours.has(v.sku));
  const sources = await d.loadSources(rows, costwayLive);
  const caDeps: CompareAtDeps = {
    now: d.now,
    getSetting: d.getSetting,
    setSetting: async () => {},
    loadLiveVariants: async () => costwayLive,
    loadSources: async () => sources,
    writeCompareAt: d.writeCompareAt,
  };
  result.compareAt = await runCompareAtSync({ deps: caDeps, persistPlan: false, minVariantsSeen: 1 });
  return result;
}

/** Turns our sell-price history rows into compare-at sources (pure, for the DB wiring and tests). */
export function costwaySources(
  rows: Array<{ internalSku: string; firstSeenAt: number | null }>,
  live: LiveVariant[],
  history: Array<{ sku: string; oldPrice: number | null; newPrice: number; at: number }>,
): Map<string, PriceSource> {
  const steps = new Map<string, PriceStep[]>();
  for (const h of history) {
    if (h.oldPrice === null || !(h.oldPrice > 0) || !(h.newPrice > 0)) continue;
    const list = steps.get(h.sku) ?? [];
    list.push({ oldPrice: h.oldPrice, newPrice: h.newPrice, at: h.at });
    steps.set(h.sku, list);
  }
  const price = new Map(live.map((v) => [v.sku, v.price]));
  const out = new Map<string, PriceSource>();
  for (const r of rows) {
    const p = price.get(r.internalSku);
    if (p === undefined) continue;
    out.set(r.internalSku, { dbPrice: p, steps: steps.get(r.internalSku) ?? [], firstSeenAt: r.firstSeenAt });
  }
  return out;
}
