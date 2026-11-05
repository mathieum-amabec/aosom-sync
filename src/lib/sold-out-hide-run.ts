/**
 * I/O wiring for sold-out-hide.ts (the decision rules and their rationale live there).
 * Reads a FRESH Aosom CSV, the Costway stock table, every Shopify product's status/tags/type
 * and the open orders, plans, then (live mode) writes with the 2/s spacing and the per-run cap.
 * Every write re-reads the product first and re-plans it, so a stale plan never overrides a
 * change made in the admin in the meantime.
 */
import { fetchAosomCatalog } from "./csv-fetcher";
import { getSetting, getStockBaseline } from "./database";
import { getImportedCostwayStock } from "./costway/db";
import { assertFeedComplete } from "./stock-reconcile";
import {
  fetchOpenOrderProductIds,
  fetchProductVisibilityStates,
  getShopifyStockState,
  publishShopifyProduct,
  updateShopifyProduct,
} from "./shopify-client";
import {
  aosomAvailability,
  assertHidePlausible,
  costwayAvailability,
  parseHideMode,
  parseSeasonWindows,
  planSoldOutHide,
  seasonalRules,
  RATE_LIMIT_MS,
  SEASONAL_WINDOWS_KEY,
  SOLD_OUT_HIDE_MODE_KEY,
  SOLD_OUT_HIDE_WRITE_CAP,
  type HideCandidateProduct,
  type HideMode,
  type HidePlan,
  type PlannedHideAction,
} from "./sold-out-hide";

export interface SoldOutHideResult {
  mode: HideMode;
  counts: HidePlan["counts"];
  applied: number;
  skippedChanged: number;
  deferred: number;
  failed: number;
  /** every planned action (dry and live) — the rollback record. */
  actions: PlannedHideAction[];
}

export interface SoldOutHideDeps {
  now: () => Date;
  getSetting: (k: string) => Promise<string | null>;
  fetchAosomCsvQty: () => Promise<Map<string, number>>;
  getAosomBaseline: () => Promise<Array<{ sku: string; shopifyProductId: string; qty: number; lastSeenAt: number }>>;
  getCostwayStock: () => Promise<Array<{ shopifyProductId: string; sku: string; inStock: boolean; qty: number }>>;
  fetchProducts: typeof fetchProductVisibilityStates;
  fetchOpenOrderProductIds: () => Promise<Set<string>>;
  getState: (id: string) => Promise<{ status: "active" | "draft" | "archived"; tags: string[] } | null>;
  setDraft: (id: string, tags: string[]) => Promise<void>;
  setActive: (id: string, tags: string[]) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: SoldOutHideDeps = {
  now: () => new Date(),
  getSetting,
  fetchAosomCsvQty: async () => {
    const csv = await fetchAosomCatalog();
    const m = new Map<string, number>();
    for (const p of csv) m.set(p.sku, p.qty);
    return m;
  },
  getAosomBaseline: getStockBaseline,
  getCostwayStock: getImportedCostwayStock,
  fetchProducts: fetchProductVisibilityStates,
  fetchOpenOrderProductIds,
  getState: getShopifyStockState,
  setDraft: async (id, tags) => { await updateShopifyProduct(id, { status: "draft", tags }); },
  // published:true as well as status:active, so a product that also lost its Online Store
  // publication comes back visible (status alone does not republish — see publish-reconcile.ts).
  setActive: (id, tags) => publishShopifyProduct(id, { activate: true, tags }),
  setTags: async (id, tags) => { await updateShopifyProduct(id, { tags }); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function runSoldOutHide(
  opts: { mode?: HideMode; maxWrites?: number } = {},
  deps: Partial<SoldOutHideDeps> = {},
): Promise<SoldOutHideResult> {
  const d: SoldOutHideDeps = { ...defaultDeps, ...deps };
  const mode = opts.mode ?? parseHideMode(await d.getSetting(SOLD_OUT_HIDE_MODE_KEY));
  const empty: HidePlan["counts"] = {
    products: 0, hideSoldOut: 0, hideSeason: 0, markSeason: 0, releaseSeason: 0, reactivate: 0,
    skippedOpenOrder: 0, skippedExcludeStale: 0, skippedAbsentFromFeed: 0, activeProducts: 0,
  };
  if (mode === "off") return { mode, counts: empty, applied: 0, skippedChanged: 0, deferred: 0, failed: 0, actions: [] };

  const now = d.now();
  const rules = seasonalRules(parseSeasonWindows(await d.getSetting(SEASONAL_WINDOWS_KEY)));

  const [csvQtyBySku, baseline, costway, shopify, openOrders] = await Promise.all([
    d.fetchAosomCsvQty(),
    d.getAosomBaseline(),
    d.getCostwayStock(),
    d.fetchProducts(),
    d.fetchOpenOrderProductIds(),
  ]);
  // A truncated CSV would make every product look sold out: abort before any write.
  assertFeedComplete(csvQtyBySku, baseline);

  const aosomSkus = new Map<string, string[]>();
  for (const r of baseline) (aosomSkus.get(r.shopifyProductId) ?? aosomSkus.set(r.shopifyProductId, []).get(r.shopifyProductId)!).push(r.sku);
  const costwayRows = new Map<string, Array<{ sku: string; inStock: boolean; qty: number }>>();
  for (const r of costway) (costwayRows.get(r.shopifyProductId) ?? costwayRows.set(r.shopifyProductId, []).get(r.shopifyProductId)!).push(r);

  const toCandidate = (p: { shopifyId: string; status: "active" | "draft" | "archived"; tags: string[]; productType: string; title: string; handle: string }): HideCandidateProduct => {
    const cw = costwayRows.get(p.shopifyId);
    if (cw) {
      return { shopifyProductId: p.shopifyId, title: p.title, handle: p.handle, status: p.status, tags: p.tags, productType: p.productType,
        skus: cw.map((r) => r.sku), source: "costway", availability: costwayAvailability(cw) };
    }
    const skus = aosomSkus.get(p.shopifyId) ?? [];
    return { shopifyProductId: p.shopifyId, title: p.title, handle: p.handle, status: p.status, tags: p.tags, productType: p.productType,
      skus, source: "aosom", availability: aosomAvailability(skus, csvQtyBySku) };
  };

  const candidates = shopify.map(toCandidate);
  const plan = planSoldOutHide({ products: candidates, openOrderProductIds: openOrders, rules, now });
  assertHidePlausible(plan);

  const res: SoldOutHideResult = { mode, counts: plan.counts, applied: 0, skippedChanged: 0, deferred: 0, failed: 0, actions: plan.actions };
  if (mode === "dry") return res;

  const cap = opts.maxWrites ?? SOLD_OUT_HIDE_WRITE_CAP;
  const byId = new Map(candidates.map((c) => [c.shopifyProductId, c]));
  for (const a of plan.actions) {
    if (res.applied >= cap) { res.deferred++; continue; }
    try {
      // Re-read and re-plan this one product from its CURRENT state.
      const live = await d.getState(a.shopifyProductId);
      const base = byId.get(a.shopifyProductId);
      if (!live || !base) { res.skippedChanged++; continue; }
      const again = planSoldOutHide({ products: [{ ...base, status: live.status, tags: live.tags }], openOrderProductIds: openOrders, rules, now }).actions[0];
      if (!again || again.action !== a.action) { res.skippedChanged++; continue; }

      if (again.targetStatus === "draft" && live.status === "active") await d.setDraft(a.shopifyProductId, again.tags);
      else if (again.targetStatus === "active") await d.setActive(a.shopifyProductId, again.tags);
      else await d.setTags(a.shopifyProductId, again.tags);
      res.applied++;
      await d.sleep(RATE_LIMIT_MS);
    } catch (err) {
      res.failed++;
      console.error(`[sold-out-hide] ${a.action} failed for ${a.shopifyProductId}:`, err);
    }
  }
  return res;
}
