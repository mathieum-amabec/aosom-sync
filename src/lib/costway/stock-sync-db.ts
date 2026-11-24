/**
 * Production wiring for stock-sync.ts: Costway rows from Turso, live variants + inventory writes on Shopify.
 */
import { createNotification, ensureSchema, getSetting, setSetting } from "@/lib/database";
import {
  enableVariantTracking,
  getPrimaryLocationId,
  readInventoryLevels,
  setInventoryLevel,
  shopifyFetch,
} from "@/lib/shopify-client";
import { COSTWAY_LAST_SYNC_KEY } from "./sync";
import { RATE_LIMIT_MS, type CostwayStockDeps, type CostwayStockRow, type StockVariant } from "./stock-sync";

/** products.json accepts up to 250 ids per call. */
const IDS_PER_CALL = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CLOSED_KEY = "costway_stock_closed";

/**
 * Every imported Costway variant that is not archived. NOT `import_status = 'active'` alone: only costway-publish.mts
 * sets it, so a product published another way would keep 'draft' here while live on Shopify and never be synced.
 * Aligning a still-draft product is harmless. `import_status` also stays 'active' for a product `sold-out-hide`
 * drafted, so its variants stay aligned and re-open correctly when it is reactivated.
 */
async function loadRows(): Promise<CostwayStockRow[]> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT internal_sku, item_no, in_stock, qty, removed_at FROM costway_products
      WHERE shopify_product_id IS NOT NULL AND shopify_product_id != '' AND internal_sku IS NOT NULL
        AND COALESCE(import_status, '') != 'archived'`,
  );
  return res.rows.map((r) => ({
    internalSku: String(r.internal_sku),
    itemNo: String(r.item_no),
    inStock: Number(r.in_stock) === 1,
    qty: Number(r.qty ?? 0),
    removed: r.removed_at !== null,
  }));
}

async function productIds(): Promise<string[]> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT DISTINCT shopify_product_id AS id FROM costway_products
      WHERE shopify_product_id IS NOT NULL AND shopify_product_id != '' AND COALESCE(import_status, '') != 'archived'`,
  );
  return res.rows.map((r) => String(r.id));
}

async function loadLive(ids: string[]): Promise<StockVariant[]> {
  const out: StockVariant[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
    const chunk = ids.slice(i, i + IDS_PER_CALL).join(",");
    const res = await shopifyFetch(`/products.json?ids=${chunk}&limit=250&fields=id,variants`);
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = (await res.json()) as {
      products: Array<{ variants: Array<{ sku: string | null; inventory_item_id: number | null; inventory_quantity: number | null; inventory_management: string | null }> }>;
    };
    for (const p of data.products) {
      for (const v of p.variants) {
        if (!v.sku || v.inventory_item_id == null) continue;
        out.push({
          sku: v.sku,
          inventoryItemId: String(v.inventory_item_id),
          inventoryQuantity: v.inventory_quantity ?? 0,
          tracked: v.inventory_management === "shopify",
        });
      }
    }
    await sleep(RATE_LIMIT_MS);
  }
  return out;
}

export function defaultCostwayStockDeps(): CostwayStockDeps {
  return {
    now: () => new Date(),
    getSetting,
    setSetting,
    async loadClosed() {
      try {
        const raw = await getSetting(CLOSED_KEY);
        const arr = raw ? (JSON.parse(raw) as unknown) : [];
        return new Set(Array.isArray(arr) ? arr.map(String) : []);
      } catch {
        return new Set<string>();
      }
    },
    async saveClosed(skus) {
      await setSetting(CLOSED_KEY, JSON.stringify(skus));
    },
    async lastCostwaySyncAt() {
      const raw = await getSetting(COSTWAY_LAST_SYNC_KEY);
      if (!raw) return null;
      try {
        const at = Number((JSON.parse(raw) as { at?: unknown }).at);
        return Number.isFinite(at) && at > 0 ? at : null;
      } catch {
        return null;
      }
    },
    loadRows,
    productIds,
    loadLive,
    getLocation: getPrimaryLocationId,
    setInventory: setInventoryLevel,
    enableTracking: enableVariantTracking,
    readInventory: readInventoryLevels,
    async notify(title, message) {
      try { await createNotification("costway-stock", title, message); } catch { /* a notification must never crash the cron */ }
    },
    sleep,
    log: (msg, extra) => console.log(JSON.stringify({ ts: new Date().toISOString(), job: "costway-stock", msg, ...extra })),
  };
}
