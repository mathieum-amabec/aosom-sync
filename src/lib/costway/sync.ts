/**
 * Daily Costway catalogue sync: feed → `costway_products`.
 *
 * Catalogue only — this never talks to Shopify. It is fully independent of the Aosom
 * sync (own table, own cron, own settings key), so a bad Costway feed can't affect the
 * Aosom catalogue and vice-versa.
 */
import { createHash } from "node:crypto";
import { getSetting, setSetting } from "@/lib/database";
import { fetchCostwayCsvText, parseCostwayCsv, validateCostwayFeed, type CostwayVariant, type ParseResult } from "./feed";
import {
  getCostwayIndex,
  markCostwayRemoved,
  updateCostwayVolatile,
  upsertCostwayFull,
  type CostwayFullRow,
  type CostwayIndexRow,
  type CostwayVolatile,
} from "./db";

export const COSTWAY_LAST_SYNC_KEY = "costway_last_sync";

export interface CostwaySyncStats {
  at: number;
  durationMs: number;
  dryRun: boolean;
  feedRows: number;
  malformedRows: number;
  incompleteRows: number;
  duplicateRows: number;
  variants: number;
  inStockVariants: number;
  products: number;
  inserted: number;
  contentUpdated: number;
  volatileUpdated: number;
  unchanged: number;
  removed: number;
}

/** Hash of the heavy, rarely-changing fields — a full-row rewrite happens only when it moves. */
export function costwayContentHash(v: CostwayVariant): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        v.itemNo, v.handle, v.title, v.bodyHtml, v.category, v.productType, v.color, v.productUrl, v.images,
      ]),
    )
    .digest("hex");
}

function volatileOf(v: CostwayVariant): CostwayVolatile {
  return {
    sku: v.sku,
    inStock: v.inStock,
    qty: v.qty,
    usQty: v.usQty,
    caQty: v.caQty,
    price: v.price,
    priceDrop: v.priceDrop,
    compareAtPrice: v.compareAtPrice,
    promoTag: v.promoTag,
  };
}

function volatileChanged(prev: CostwayIndexRow, v: CostwayVariant): boolean {
  return (
    prev.removed ||
    prev.inStock !== v.inStock ||
    prev.qty !== v.qty ||
    prev.usQty !== v.usQty ||
    prev.caQty !== v.caQty ||
    prev.price !== v.price ||
    prev.priceDrop !== v.priceDrop ||
    prev.compareAtPrice !== v.compareAtPrice ||
    prev.promoTag !== v.promoTag
  );
}

export interface CostwaySyncPlan {
  full: CostwayFullRow[];
  inserted: number;
  volatile: CostwayVolatile[];
  unchanged: number;
  removed: string[];
}

/** Pure diff of the parsed feed against the current DB index. */
export function planCostwaySync(variants: CostwayVariant[], index: Map<string, CostwayIndexRow>): CostwaySyncPlan {
  const plan: CostwaySyncPlan = { full: [], inserted: 0, volatile: [], unchanged: 0, removed: [] };
  const inFeed = new Set<string>();
  for (const v of variants) {
    inFeed.add(v.sku);
    const hash = costwayContentHash(v);
    const prev = index.get(v.sku);
    if (!prev || prev.contentHash !== hash) {
      if (!prev) plan.inserted++;
      plan.full.push({ ...v, contentHash: hash });
    } else if (volatileChanged(prev, v)) {
      plan.volatile.push(volatileOf(v));
    } else {
      plan.unchanged++;
    }
  }
  for (const [sku, row] of index) {
    if (!row.removed && !inFeed.has(sku)) plan.removed.push(sku);
  }
  return plan;
}

function lastRowCount(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const n = Number((JSON.parse(raw) as Partial<CostwaySyncStats>).variants);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Run the sync. `text` lets tests (and a future manual upload) inject a feed; by default
 * the live feed is downloaded. With `dryRun` nothing is written.
 */
export async function runCostwaySync(opts: { dryRun?: boolean; text?: string } = {}): Promise<CostwaySyncStats> {
  const started = Date.now();
  const dryRun = !!opts.dryRun;
  const text = opts.text ?? (await fetchCostwayCsvText());
  const parsed: ParseResult = parseCostwayCsv(text);

  const previous = await getSetting(COSTWAY_LAST_SYNC_KEY);
  validateCostwayFeed(parsed, lastRowCount(previous));

  const index = await getCostwayIndex();
  const plan = planCostwaySync(parsed.variants, index);

  const now = Math.floor(Date.now() / 1000);
  if (!dryRun) {
    await upsertCostwayFull(plan.full, now);
    await updateCostwayVolatile(plan.volatile, now);
    await markCostwayRemoved(plan.removed, now);
  }

  const stats: CostwaySyncStats = {
    at: now,
    durationMs: Date.now() - started,
    dryRun,
    feedRows: parsed.totalRows,
    malformedRows: parsed.malformedRows,
    incompleteRows: parsed.incompleteRows,
    duplicateRows: parsed.duplicateRows,
    variants: parsed.variants.length,
    inStockVariants: parsed.variants.filter((v) => v.inStock).length,
    products: new Set(parsed.variants.map((v) => v.itemNo)).size,
    inserted: plan.inserted,
    contentUpdated: plan.full.length - plan.inserted,
    volatileUpdated: plan.volatile.length,
    unchanged: plan.unchanged,
    removed: plan.removed.length,
  };
  if (!dryRun) await setSetting(COSTWAY_LAST_SYNC_KEY, JSON.stringify(stats));
  return stats;
}

export async function getCostwayLastSync(): Promise<CostwaySyncStats | null> {
  const raw = await getSetting(COSTWAY_LAST_SYNC_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CostwaySyncStats;
  } catch {
    return null;
  }
}
