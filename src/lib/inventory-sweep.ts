/**
 * Daily inventory sweep — feed-aware reconciliation of Shopify inventory.
 *
 * The daily Shopify push (Phase 2) only touches variants whose DB row changed today
 * (getAllProductsAsAosom filters last_seen_at >= today), so a variant that vanished from
 * the feed — or dropped low — but didn't "change" is never re-pushed, and its Shopify
 * inventory stays frozen while inventory_policy=deny waits for a 0 that never comes.
 *
 * This sweep is feed-aware and covers EVERY active tracked variant, not just changed ones.
 * It is a DOWNWARD-SAFE reconcile toward the buffered target stockBufferQty(feed_qty) — the
 * same target the daily push computes:
 *   absent / feed_qty <= STOCK_SOLD_OUT_MAX → 0            (deny blocks the sale)
 *   feed_qty > STOCK_SOLD_OUT_MAX           → feed_qty - 3 (buffered, sellable)
 * The daily push (Phase 2) only touches variants whose DB row changed today, so a threshold
 * change, a failed push, or an over-count leaves Shopify drifted ABOVE the supplier cap with
 * no self-correction — a latent oversell. This sweep closes that for the whole catalog: it
 * writes a variant DOWN to the cap whenever Shopify sits above it, and self-heals a fully
 * zeroed variant back into the feed (0→N). It deliberately does NOT raise a sold-down nonzero
 * variant back up: under deny, the Shopify count is the only intraday oversell guard against a
 * feed that refreshes just once at 06:00, so refilling it here would reopen the oversell. That
 * upward "restore" stays with the change-gated push, which fires on a real feed move. Writing
 * only on a real difference keeps it idempotent; zeros are written first (worst-first) so the
 * per-run cap never starves the oversell-stopping half.
 * Variant-level → live siblings keep selling; no drafting, no SEO/URL loss.
 *
 * Guard: if the fetched feed covers < MIN_ACTIVE_COVERAGE of active tracked variant SKUs,
 * do NOTHING (a truncated CSV must never mass-flip the catalog). A per-run WRITE_CAP bounds
 * blast radius; the pass is convergent, so a capped run is drained by the next. Pure core
 * is unit-testable.
 */
import { STOCK_SOLD_OUT_MAX, stockBufferQty } from "@/lib/diff-engine";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import {
  fetchActiveVariantInventory,
  getPrimaryLocationId,
  setInventoryLevel,
} from "@/lib/shopify-client";

/** Minimum fraction of active tracked variant SKUs the feed must cover before we reconcile. */
export const MIN_ACTIVE_COVERAGE = 0.8;
/** Spacing between Shopify inventory writes → ~2 req/second (Shopify Admin limit). */
export const RATE_LIMIT_MS = 550;
/** Max inventory writes per run — bounds blast radius; convergent (next run drains the rest). */
export const WRITE_CAP = 250;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SweepVariant {
  sku: string;
  inventoryQuantity: number;
  inventoryItemId: string;
  /** inventory_management === "shopify" — only tracked variants can have inventory set. */
  tracked: boolean;
}

export interface InventorySweepPlan {
  guard: { activeTracked: number; covered: number; coverage: number; ok: boolean };
  /** Variants whose Shopify inventory != buffered feed target (to = 0 for sold-out/absent, else buffered). */
  toSet: Array<{ sku: string; inventoryItemId: string; from: number; to: number }>;
}

/** The feed-derived Shopify inventory target for one variant. */
export function targetInventory(
  sku: string,
  feedQty: Map<string, number>,
  soldOutMax: number,
): number {
  const q = feedQty.get(sku.toUpperCase());
  if (q === undefined) return 0;          // absent from the feed → sold out
  if (q <= soldOutMax) return 0;          // danger zone → sold out
  return stockBufferQty(q);               // sellable, buffered
}

/** Pure decision core — no I/O. */
export function planInventorySweep(input: {
  variants: SweepVariant[];
  feedQty: Map<string, number>;
  soldOutMax?: number;
  minCoverage?: number;
}): InventorySweepPlan {
  const soldOutMax = input.soldOutMax ?? STOCK_SOLD_OUT_MAX;
  const minCoverage = input.minCoverage ?? MIN_ACTIVE_COVERAGE;
  const feedHas = (sku: string) => input.feedQty.has(sku.toUpperCase());

  // Feed-completeness guard over active TRACKED variant SKUs (only those a truncated feed
  // could falsely make "absent"). Below the floor → no writes at all.
  let activeTracked = 0;
  let covered = 0;
  for (const v of input.variants) {
    if (!v.tracked) continue;
    activeTracked++;
    if (feedHas(v.sku)) covered++;
  }
  const coverage = activeTracked === 0 ? 1 : covered / activeTracked;
  const ok = coverage >= minCoverage;
  const guard = { activeTracked, covered, coverage, ok };
  if (!ok) return { guard, toSet: [] };

  // Downward-safe reconcile: correct every oversell-direction drift, but NEVER raise a
  // sold-down nonzero variant back up. Under inventory_policy=deny the Shopify count is the
  // ONLY intraday oversell guard (the feed refreshes once at 06:00; the sweep runs off that
  // same-day feed), so topping a variant that sold 11→3 back up to 11 would let it oversell a
  // stale feed — the exact failure this workstream exists to kill. We write only when:
  //   to < inv                    → tighten the cap: absent/sold-out (to=0) OR over-count → down
  //   inv === 0 AND to > 0        → self-heal a fully-zeroed variant back into the feed (0→N)
  // We deliberately do NOT write when to > inv AND inv > 0 (a sold-down nonzero variant): that
  // upward "restore" is left to the change-gated daily push, which fires on a real feed move.
  const toSet: InventorySweepPlan["toSet"] = [];
  for (const v of input.variants) {
    if (!v.tracked || !v.inventoryItemId) continue;   // can't set inventory on an untracked/unknown item
    const to = targetInventory(v.sku, input.feedQty, soldOutMax);
    if (!Number.isFinite(to)) continue;               // bad CSV qty → NaN target; never write NaN / thrash
    const tightenCap = to < v.inventoryQuantity;                        // down: stop oversell / over-count
    const healZero = v.inventoryQuantity === 0 && to > 0;              // 0→N: self-heal a transient zero
    if (tightenCap || healZero) toSet.push({ sku: v.sku, inventoryItemId: v.inventoryItemId, from: v.inventoryQuantity, to });
  }
  return { guard, toSet };
}

export interface InventorySweepResult {
  ran: boolean;
  guardTripped: boolean;
  coverage: number;
  scanned: number;
  /** Variants set to 0 (sold-out/absent). */
  zeroed: number;
  /** Variants set to a positive buffered qty (self-heal 0→N or drift correction N→M). */
  restored: number;
  failed: number;
  /** Planned writes beyond the per-run cap, deferred to the next run. */
  deferred: number;
}

export interface InventorySweepDeps {
  fetchFeed?: () => Promise<Array<{ sku: string; qty: number }>>;
  fetchVariants?: () => Promise<SweepVariant[]>;
  getLocation?: () => Promise<string>;
  setInventory?: (inventoryItemId: string, locationId: string, available: number) => Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  rateLimitMs?: number;
  writeCap?: number;
}

const defaultLog = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: "inventory-sweep", msg, ...extra }));

/** Wire the plan to the Aosom feed + Shopify. Non-fatal per item, capped per run. */
export async function runInventorySweep(deps: InventorySweepDeps = {}): Promise<InventorySweepResult> {
  const log = deps.log ?? defaultLog;
  const csv = deps.fetchFeed ? await deps.fetchFeed() : await fetchAosomCatalog();
  const feedQty = new Map<string, number>();
  for (const p of csv) feedQty.set(p.sku.toUpperCase(), p.qty);

  const variants = deps.fetchVariants ? await deps.fetchVariants() : await fetchActiveVariantInventory();
  const plan = planInventorySweep({ variants, feedQty });
  const empty: InventorySweepResult = {
    ran: true, guardTripped: false, coverage: plan.guard.coverage, scanned: variants.length,
    zeroed: 0, restored: 0, failed: 0, deferred: 0,
  };

  if (!plan.guard.ok) {
    log(`GARDE-FOU: couverture ${(plan.guard.coverage * 100).toFixed(1)}% < ${MIN_ACTIVE_COVERAGE * 100}% — feed suspect, aucune écriture`, {
      active_tracked: plan.guard.activeTracked, covered: plan.guard.covered,
    });
    return { ...empty, guardTripped: true };
  }
  if (plan.toSet.length === 0) {
    log("inventaire déjà aligné sur le feed — rien à écrire", { scanned: variants.length });
    return empty;
  }

  const cap = deps.writeCap ?? WRITE_CAP;
  // Worst-first: zeros (stop oversell) before restores, so the cap never starves the safety half.
  const ordered = [...plan.toSet].sort((a, b) => a.to - b.to);
  const batch = ordered.slice(0, cap);
  const deferred = ordered.length - batch.length;

  const getLocation = deps.getLocation ?? getPrimaryLocationId;
  const setInventory = deps.setInventory ?? setInventoryLevel;
  const rate = deps.rateLimitMs ?? RATE_LIMIT_MS;
  const locationId = await getLocation();

  let zeroed = 0, restored = 0, failed = 0;
  for (const t of batch) {
    try {
      await setInventory(t.inventoryItemId, locationId, t.to);
      if (t.to === 0) zeroed++; else restored++;
      log(`inv ${t.from}→${t.to}`, { sku: t.sku });
    } catch (err) {
      failed++;
      log(`échec ${t.sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rate > 0) await wait(rate);
  }
  log(`sweep terminé: ${zeroed} zéros, ${restored} restaurés/ajustés, ${failed} échecs, ${deferred} reportés sur ${variants.length} variantes`, {
    coverage: plan.guard.coverage,
  });
  return { ran: true, guardTripped: false, coverage: plan.guard.coverage, scanned: variants.length, zeroed, restored, failed, deferred };
}
