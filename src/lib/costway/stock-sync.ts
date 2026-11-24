/**
 * Costway → Shopify stock, PER VARIANT (2026-11-23).
 *
 * Incident: order #1155 sold a Costway dehumidifier (colour Blue) that Costway had marked out of stock days
 * earlier. `costway-sync` only refreshes our `costway_products` table; a variant's Shopify quantity was set ONCE at
 * import (importer.ts) and never moved again, the Aosom `inventory-sweep` deliberately skips Costway products, and
 * `sold-out-hide` only drafts a product when EVERY variant is unsellable. A sold-out colour of a product that still
 * has another colour in stock therefore stayed buyable. 135 of 773 imported variants were in that state.
 *
 * This job closes it, variant by variant:
 *   target = removed OR not in_stock → 0, else sellableQty(qty)  (0 under 3 units, capped at 50 — pricing.ts)
 *   - DOWN is always written (to < Shopify): stops the oversell.
 *   - UP is written only for a variant THIS JOB closed (0 → N, a Costway restock). A variant that customers sold
 *     down to 0 while Costway still shows units is NOT re-opened: Mat has not ordered those units yet. "Closed by
 *     this job" = its Costway target was 0 at the previous run (`settings.costway_stock_closed`).
 *   - an UNTRACKED variant is sellable forever whatever its quantity: tracking is switched on first, then the
 *     target is written (the importer tracks every Costway variant, so this is a repair path).
 *   - each write is re-checked against a fresh Shopify read just before it (chunks of 50): a sale that landed
 *     between planning and writing is never overwritten upward.
 *
 * Variant-level only: no drafting, no SEO/URL loss; a restock re-opens the variant by itself.
 * Mode `settings.costway_stock_mode` = off | dry | live — DEFAULT dry (plan + report, no Shopify write).
 * Guards: a stale Costway sync (>30 h) → no run; a plan that zeroes more than max(150, 40 %) of the sellable
 * variants is held back as a probable feed fault (`force` overrides it for one call); per-run cap; canary.
 */
import { sellableQty } from "./pricing";

export const COSTWAY_STOCK_MODE_KEY = "costway_stock_mode";
export type CostwayStockMode = "off" | "dry" | "live";
/** Shopify Admin REST allows about 2 req/s. */
export const RATE_LIMIT_MS = 550;
/** Max Shopify variant writes per run; the pass is convergent, the next run drains the rest. */
export const WRITE_CAP = 250;
/** A Costway sync older than this is not trusted. */
export const MAX_SYNC_AGE_S = 30 * 3600;
/** Zeroing more than max(MASS_ZERO_FLOOR, MASS_ZERO_SHARE of the currently sellable variants) in one pass is held back. */
export const MASS_ZERO_FLOOR = 150;
export const MASS_ZERO_SHARE = 0.4;
/** Re-read this many just-written variants to confirm the write stuck. */
export const CANARY_SAMPLE = 10;
/** inventory_levels.json takes at most 50 item ids per call. */
const READ_CHUNK = 50;
/** One alert per kind per day (the job runs twice a day). */
const ALERT_DAY_KEY = "costway_stock_alert_day";

export function parseStockMode(raw: string | null): CostwayStockMode {
  return raw === "off" || raw === "live" ? raw : "dry";
}

export interface CostwayStockRow {
  /** Our opaque internal SKU = the Shopify variant SKU. */
  internalSku: string;
  itemNo: string;
  inStock: boolean;
  qty: number;
  removed: boolean;
}

export interface StockVariant {
  sku: string;
  inventoryItemId: string;
  inventoryQuantity: number;
  /** inventory_management === "shopify". */
  tracked: boolean;
}

/** What Shopify should hold for one Costway variant. */
export function targetStock(r: Pick<CostwayStockRow, "inStock" | "qty" | "removed">): number {
  if (r.removed || !r.inStock) return 0;
  return sellableQty(r.qty);
}

/** tighten = lower an over-count / close; heal = re-open a variant this job closed; track = untracked → tracked. */
export type StockChangeKind = "tighten" | "heal" | "track";

export interface StockChange {
  sku: string;
  itemNo: string;
  inventoryItemId: string;
  from: number;
  to: number;
  enableTracking: boolean;
  kind: StockChangeKind;
}

export interface StockPlan {
  changes: StockChange[];
  /** Variants already aligned (or deliberately left alone: a sold-down variant, a customer-emptied one). */
  same: number;
  /** Costway rows whose variant is not on Shopify (deleted variant, product gone). */
  missing: number;
  /** Shopify variants (of Costway products) with no Costway row — never touched. */
  unmapped: number;
  /** Variants currently sellable on Shopify (quantity > 0 or untracked). */
  sellableNow: number;
  /** Changes that close a sale (to = 0 from a sellable state). */
  zeroing: number;
}

/** SKUs whose Costway target is 0 right now: what the NEXT run may re-open. */
export function closedSet(rows: CostwayStockRow[]): string[] {
  return rows.filter((r) => targetStock(r) === 0).map((r) => r.internalSku);
}

/** Pure decision core — no I/O. `closedBefore` = the previous run's closedSet (who may be healed). */
export function planStockSync(rows: CostwayStockRow[], live: StockVariant[], closedBefore: ReadonlySet<string> = new Set()): StockPlan {
  const bySku = new Map(live.map((v) => [v.sku, v]));
  const known = new Set(rows.map((r) => r.internalSku));
  const plan: StockPlan = { changes: [], same: 0, missing: 0, unmapped: 0, sellableNow: 0, zeroing: 0 };
  for (const v of live) {
    if (!known.has(v.sku)) plan.unmapped++;
    else if (!v.tracked || v.inventoryQuantity > 0) plan.sellableNow++;
  }
  for (const r of rows) {
    const v = bySku.get(r.internalSku);
    if (!v || !v.inventoryItemId) { plan.missing++; continue; }
    const to = targetStock(r);
    const base = { sku: r.internalSku, itemNo: r.itemNo, inventoryItemId: v.inventoryItemId, from: v.inventoryQuantity };

    if (!v.tracked) {
      // Untracked = sellable forever, whatever the number says. We own the number (the job runs twice a day and the
      // importer tracks every Costway variant): tracking on, then the target.
      plan.changes.push({ ...base, to, enableTracking: true, kind: "track" });
      if (to === 0) plan.zeroing++;
      continue;
    }
    const tighten = to < v.inventoryQuantity;
    const heal = v.inventoryQuantity === 0 && to > 0 && closedBefore.has(r.internalSku);
    if (tighten) {
      plan.changes.push({ ...base, to, enableTracking: false, kind: "tighten" });
      if (to === 0) plan.zeroing++;
    } else if (heal) {
      plan.changes.push({ ...base, to, enableTracking: false, kind: "heal" });
    } else plan.same++;
  }
  // Worst first: closing sales before restocks, so the per-run cap never starves the safety half.
  plan.changes.sort((a, b) => a.to - b.to);
  return plan;
}

export interface CostwayStockDeps {
  now(): Date;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Unix seconds of the last successful costway-sync, or null. */
  lastCostwaySyncAt(): Promise<number | null>;
  loadRows(): Promise<CostwayStockRow[]>;
  loadLive(productIds: string[]): Promise<StockVariant[]>;
  /** Shopify product ids of the rows (to know which products to read). */
  productIds(): Promise<string[]>;
  /** The previous run's closed set (see closedSet). */
  loadClosed(): Promise<Set<string>>;
  saveClosed(skus: string[]): Promise<void>;
  getLocation(): Promise<string>;
  setInventory(inventoryItemId: string, locationId: string, available: number): Promise<void>;
  enableTracking(inventoryItemId: string): Promise<void>;
  readInventory(inventoryItemIds: string[], locationId: string): Promise<Map<string, number>>;
  notify(title: string, message: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(msg: string, extra?: Record<string, unknown>): void;
}

export interface CostwayStockResult {
  mode: CostwayStockMode;
  skipped?: string;
  plan: StockPlan;
  applied: number;
  zeroed: number;
  restored: number;
  trackingEnabled: number;
  failed: number;
  deferred: number;
  /** Planned writes dropped because the fresh Shopify read no longer matched the plan (a sale landed meanwhile). */
  staleSkipped: number;
  verified: number;
  verifyMismatch: number;
  /** Dry-run / held-back detail so the operator can read what would be written. */
  preview: Array<{ sku: string; itemNo: string; from: number; to: number; enableTracking: boolean; kind: StockChangeKind }>;
}

const emptyPlan = (): StockPlan => ({ changes: [], same: 0, missing: 0, unmapped: 0, sellableNow: 0, zeroing: 0 });

export async function runCostwayStockSync(opts: {
  deps: CostwayStockDeps;
  mode?: CostwayStockMode;
  writeCap?: number;
  /** Bypass the mass-zero breaker for this call (operator decision, `?force=1`). */
  force?: boolean;
}): Promise<CostwayStockResult> {
  const d = opts.deps;
  const mode = opts.mode ?? parseStockMode(await d.getSetting(COSTWAY_STOCK_MODE_KEY));
  const base: CostwayStockResult = {
    mode, plan: emptyPlan(), applied: 0, zeroed: 0, restored: 0, trackingEnabled: 0, failed: 0, deferred: 0,
    staleSkipped: 0, verified: 0, verifyMismatch: 0, preview: [],
  };
  if (mode === "off") return { ...base, skipped: "off" };

  // At most one alert per kind per day, whatever the number of runs.
  const alertOnce = async (kind: string, title: string, message: string) => {
    const today = `${kind}:${d.now().toISOString().slice(0, 10)}`;
    const seen = new Set((await d.getSetting(ALERT_DAY_KEY))?.split("|") ?? []);
    if (seen.has(today)) return;
    await d.notify(title, message);
    await d.setSetting(ALERT_DAY_KEY, [...[...seen].filter((s) => s.endsWith(today.slice(-10))), today].join("|"));
  };

  // Freshness: never act on a Costway sync that did not run (or ran long ago).
  const syncAt = await d.lastCostwaySyncAt();
  const ageS = syncAt == null ? Infinity : Math.floor(d.now().getTime() / 1000) - syncAt;
  if (ageS > MAX_SYNC_AGE_S) {
    if (mode === "live") await alertOnce("stale", "Stock Costway — sync périmée", "Le costway-sync date de plus de 30 h: le stock Costway n'est pas poussé vers Shopify tant qu'il ne repasse pas.");
    return { ...base, skipped: "stale-costway-sync" };
  }

  const rows = await d.loadRows();
  if (rows.length === 0) return { ...base, skipped: "no-rows" };
  const live = await d.loadLive(await d.productIds());
  if (live.length === 0) return { ...base, skipped: "no-shopify-variants" };

  const plan = planStockSync(rows, live, await d.loadClosed());
  const preview = plan.changes.map((c) => ({ sku: c.sku, itemNo: c.itemNo, from: c.from, to: c.to, enableTracking: c.enableTracking, kind: c.kind }));
  const result: CostwayStockResult = { ...base, plan, preview };
  if (mode === "dry") return { ...result, skipped: "dry-run" };

  // Mass-zero breaker: a bad feed that flips half the catalogue out of stock must not empty the store.
  const limit = Math.max(MASS_ZERO_FLOOR, Math.ceil(plan.sellableNow * MASS_ZERO_SHARE));
  if (plan.zeroing > limit && !opts.force) {
    await alertOnce(
      "mass-zero",
      "Stock Costway — arrêt par garde-fou",
      `${plan.zeroing} variantes à fermer d'un coup (limite ${limit} sur ${plan.sellableNow} vendables): probable erreur du flux Costway, aucune écriture. ` +
        `Après vérification: /api/cron/costway-stock?mode=live&force=1.`,
    );
    return { ...result, skipped: "mass-zero-guard" };
  }
  // The next run may re-open exactly the variants Costway says are unavailable now.
  await d.saveClosed(closedSet(rows));
  if (plan.changes.length === 0) return result;

  const cap = opts.writeCap ?? WRITE_CAP;
  const batch = plan.changes.slice(0, cap);
  result.deferred = plan.changes.length - batch.length;
  const locationId = await d.getLocation();

  // Fresh read just before writing: a sale that landed since planning must never be overwritten upward.
  const fresh = new Map<string, number>();
  const tracked = batch.filter((c) => !c.enableTracking);
  for (let i = 0; i < tracked.length; i += READ_CHUNK) {
    try {
      const got = await d.readInventory(tracked.slice(i, i + READ_CHUNK).map((c) => c.inventoryItemId), locationId);
      for (const [k, v] of got) fresh.set(k, v);
    } catch (err) {
      d.log(`relecture avant écriture ignorée: ${err instanceof Error ? err.message : String(err)}`);
    }
    await d.sleep(RATE_LIMIT_MS);
  }

  const written: Array<{ inventoryItemId: string; sku: string; to: number }> = [];
  for (const c of batch) {
    const cur = c.enableTracking ? undefined : fresh.get(c.inventoryItemId);
    // Unknown (no level / read failed) → trust the plan; a known value must still satisfy the rule that justified the write.
    if (cur !== undefined && ((c.kind === "tighten" && !(cur > c.to)) || (c.kind === "heal" && cur !== 0))) {
      result.staleSkipped++;
      continue;
    }
    try {
      // Untracked → tracking FIRST: setting a level on an untracked item is a silent no-op that leaves it sellable.
      if (c.enableTracking) {
        await d.enableTracking(c.inventoryItemId);
        result.trackingEnabled++;
        await d.sleep(RATE_LIMIT_MS);
      }
      await d.setInventory(c.inventoryItemId, locationId, c.to);
      if (c.to === 0) result.zeroed++; else result.restored++;
      result.applied++;
      written.push({ inventoryItemId: c.inventoryItemId, sku: c.sku, to: c.to });
      d.log(`stock ${cur ?? c.from}→${c.to}`, { sku: c.sku, item: c.itemNo, kind: c.kind });
    } catch (err) {
      result.failed++;
      d.log(`échec ${c.sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await d.sleep(RATE_LIMIT_MS);
  }

  // Canary: re-read a sample; a live value ABOVE the target means the write did not stick (still oversellable).
  const sample = written.slice(0, CANARY_SAMPLE);
  if (sample.length > 0) {
    try {
      const levels = await d.readInventory(sample.map((s) => s.inventoryItemId), locationId);
      const over: string[] = [];
      for (const s of sample) {
        const got = levels.get(s.inventoryItemId);
        if (got !== undefined && got <= s.to) result.verified++;
        else { result.verifyMismatch++; over.push(`${s.sku}(cap ${s.to}, lu ${got ?? "absent"})`); }
      }
      if (result.verifyMismatch > 0) {
        await alertOnce("canary", "Stock Costway — écritures non appliquées", `${result.verifyMismatch}/${sample.length} variantes restent au-dessus de leur cap: ${over.slice(0, 10).join(", ")}`);
      }
    } catch (err) {
      d.log(`verify ignoré: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (result.failed > 0) {
    await alertOnce("failed", "Stock Costway — échecs d'écriture", `${result.failed} variante(s) n'ont pas pu être mises à jour sur Shopify (reprise au prochain passage).`);
  }
  return result;
}
