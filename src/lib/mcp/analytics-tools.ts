/**
 * Analytics tools (scope `analytics`): read-only aggregates over the catalogue DB.
 *
 * NOT here: Shopify sales/orders. The store's Admin API token has no `read_orders` scope today
 * (403 "requires merchant approval for read_orders"), so a sales summary needs that scope approved
 * in the Shopify app first. "Units moved" below is the SUPPLIER's stock decreasing between daily
 * syncs — a demand proxy, not our own order count.
 */
import type { Db, ToolDef } from "@/lib/mcp/tools";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: unknown, def: number, min: number, max: number) => Math.min(Math.max(Math.trunc(num(v) ?? def), min), max);
const LISTED = `(shopify_product_id IS NOT NULL AND shopify_product_id <> '')`;

async function rows(db: Db, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("MCP tools are read-only: only a single SELECT is allowed");
  return (await db.execute({ sql, args })).rows as Record<string, unknown>[];
}

export const ANALYTICS_TOOLS: ToolDef[] = [
  {
    scope: "analytics",
    name: "inventory_summary",
    description:
      "Inventory health at a glance: Aosom products live on the store (in stock / sold out / low stock) and import candidates " +
      "(in the supplier feed with stock but not yet imported), plus the Costway counts.",
    inputSchema: { type: "object", properties: { low_stock_below: { type: "number", description: "Default 5" } } },
    handler: async (db, a) => {
      const low = clamp(a.low_stock_below, 5, 1, 100);
      const [aosom] = await rows(db,
        `SELECT SUM(${LISTED}) AS listed,
                SUM(${LISTED} AND qty > 0) AS listed_in_stock,
                SUM(${LISTED} AND qty <= 0) AS listed_sold_out,
                SUM(${LISTED} AND qty > 0 AND qty < ?) AS listed_low_stock,
                SUM(NOT ${LISTED} AND qty > 0) AS import_candidates
           FROM products`, [low]);
      const [costway] = await rows(db,
        `SELECT COUNT(DISTINCT item_no) AS products, COUNT(DISTINCT CASE WHEN ${LISTED} THEN item_no END) AS listed_products,
                SUM(qty >= 3) AS sellable_variants
           FROM costway_products WHERE removed_at IS NULL`);
      return { low_stock_threshold: low, aosom, costway };
    },
  },
  {
    scope: "analytics",
    name: "low_stock_listed",
    description: "Aosom products currently live on the store whose supplier stock is low (or zero), lowest first.",
    inputSchema: { type: "object", properties: { below: { type: "number", description: "Default 5" }, limit: { type: "number", description: "1-25, default 15" } } },
    handler: async (db, a) => ({
      products: await rows(db,
        `SELECT sku, name, qty, price, product_type, shopify_product_id FROM products
          WHERE ${LISTED} AND qty < ? ORDER BY qty ASC, name ASC LIMIT ${clamp(a.limit, 15, 1, 25)}`, [clamp(a.below, 5, 1, 100)]),
    }),
  },
  {
    scope: "analytics",
    name: "best_sellers",
    description:
      "Live Aosom products ranked by supplier-stock units moved over the last N days (a demand proxy: units the supplier's stock dropped by " +
      "between daily syncs — not our own orders).",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "1-30, default 14" }, limit: { type: "number", description: "1-25, default 10" } } },
    handler: async (db, a) => {
      const since = Math.floor(Date.now() / 1000) - clamp(a.days, 14, 1, 30) * 86400;
      return {
        products: await rows(db,
          `SELECT p.sku, p.name, p.price, p.qty, SUM(ph.old_qty - ph.new_qty) AS units_moved
             FROM price_history ph JOIN products p ON p.sku = ph.sku
            WHERE ph.change_type = 'stock_change' AND ph.detected_at > ? AND ph.old_qty > ph.new_qty AND p.shopify_product_id IS NOT NULL
            GROUP BY ph.sku ORDER BY units_moved DESC LIMIT ${clamp(a.limit, 10, 1, 25)}`, [since]),
      };
    },
  },
  {
    scope: "analytics",
    name: "price_changes",
    description: "Recent supplier price changes (drops / increases), newest first. Defaults to products live on the store.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "1-30, default 7" },
        direction: { type: "string", enum: ["drop", "increase", "all"], description: "Default all" },
        listed_only: { type: "boolean", description: "Default true" },
        limit: { type: "number", description: "1-25, default 15" },
      },
    },
    handler: async (db, a) => {
      const since = Math.floor(Date.now() / 1000) - clamp(a.days, 7, 1, 30) * 86400;
      const types = a.direction === "drop" ? ["price_drop"] : a.direction === "increase" ? ["price_increase"] : ["price_drop", "price_increase"];
      return {
        changes: await rows(db,
          `SELECT ph.sku, p.name, ph.change_type, ph.old_price, ph.new_price, datetime(ph.detected_at, 'unixepoch') AS detected_utc
             FROM price_history ph JOIN products p ON p.sku = ph.sku
            WHERE ph.change_type IN (${types.map(() => "?").join(",")}) AND ph.detected_at > ?
              ${a.listed_only === false ? "" : `AND p.shopify_product_id IS NOT NULL AND p.shopify_product_id <> ''`}
            ORDER BY ph.detected_at DESC LIMIT ${clamp(a.limit, 15, 1, 25)}`, [...types, since]),
      };
    },
  },
  {
    scope: "analytics",
    name: "imports_timeline",
    description: "Products imported per day over the last N days (Aosom import jobs finished + Costway imports).",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "1-60, default 14" } } },
    handler: async (db, a) => {
      const days = clamp(a.days, 14, 1, 60);
      const since = Math.floor(Date.now() / 1000) - days * 86400;
      return {
        aosom_by_day: await rows(db,
          `SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS imported FROM import_jobs
            WHERE status = 'done' AND substr(updated_at, 1, 10) >= date(?, 'unixepoch') GROUP BY day ORDER BY day DESC`, [since]),
        costway_by_day: await rows(db,
          `SELECT date(imported_at, 'unixepoch') AS day, COUNT(DISTINCT item_no) AS imported FROM costway_products
            WHERE imported_at >= ? GROUP BY day ORDER BY day DESC`, [since]),
      };
    },
  },
];
