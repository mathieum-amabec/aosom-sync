/**
 * Production wiring for sell-price-sync.ts, plus the readers the price writers and checkers share.
 */
import { ensureSchema, getSetting, setSetting } from "@/lib/database";
import { fetchCompetitorPrices } from "@/lib/competitor-prices";
import { effectiveSellPrice } from "@/lib/pricing";
import type { SellPriceChange, SellPriceDeps, SellPriceRow, CompetitorSnapshot } from "@/lib/sell-price-sync";

/** A cached competitor snapshot younger than this is reused instead of refetching (their catalogue is ~8k SKUs). */
const COMPETITOR_FRESH_SECONDS = 20 * 3600;
/** An older snapshot is still better than falling back to tiers for a few days; beyond this it is ignored. */
const COMPETITOR_STALE_MAX_SECONDS = 7 * 86_400;
const CHUNK = 400;

/** SKU -> stored sell price, for every product that has one. */
export async function getSellPriceMap(): Promise<Map<string, number>> {
  const db = await ensureSchema();
  const r = await db.execute(`SELECT sku, sell_price FROM products WHERE sell_price IS NOT NULL AND sell_price > 0`);
  const m = new Map<string, number>();
  for (const row of r.rows) m.set(String(row.sku), Number(row.sell_price));
  return m;
}

/** The price each product should sell at now (stored sell price when sane, else the Aosom floor). */
export async function getExpectedSellPrices(): Promise<Array<{ sku: string; price: number }>> {
  const db = await ensureSchema();
  const r = await db.execute(`SELECT sku, price, sell_price FROM products WHERE price > 0`);
  const out: Array<{ sku: string; price: number }> = [];
  for (const row of r.rows) {
    const p = effectiveSellPrice(Number(row.price), row.sell_price == null ? null : Number(row.sell_price));
    if (Number.isFinite(p) && p > 0) out.push({ sku: String(row.sku), price: p });
  }
  return out;
}

/** The sell price for specific SKUs (used when creating a Shopify product). Missing SKUs are simply absent. */
export async function getSellPricesForSkus(skus: string[]): Promise<Map<string, number>> {
  const db = await ensureSchema();
  const out = new Map<string, number>();
  for (let i = 0; i < skus.length; i += CHUNK) {
    const part = skus.slice(i, i + CHUNK);
    if (part.length === 0) continue;
    const r = await db.execute({ sql: `SELECT sku, sell_price FROM products WHERE sell_price IS NOT NULL AND sku IN (${part.map(() => "?").join(",")})`, args: part });
    for (const row of r.rows) out.set(String(row.sku), Number(row.sell_price));
  }
  return out;
}

async function loadCompetitor(): Promise<CompetitorSnapshot> {
  const db = await ensureSchema();
  const nowS = Math.floor(Date.now() / 1000);
  const age = await db.execute(`SELECT MAX(fetched_at) AS t, COUNT(*) AS n FROM competitor_prices`);
  const lastFetched = Number(age.rows[0]?.t ?? 0);
  const count = Number(age.rows[0]?.n ?? 0);
  const readCache = async (): Promise<Map<string, number>> => {
    const r = await db.execute(`SELECT sku, price FROM competitor_prices`);
    return new Map(r.rows.map((x) => [String(x.sku), Number(x.price)] as const));
  };
  if (count > 0 && nowS - lastFetched < COMPETITOR_FRESH_SECONDS) return { prices: await readCache(), source: "cache" };

  const fresh = await fetchCompetitorPrices();
  if (fresh) {
    await db.execute(`DELETE FROM competitor_prices`);
    const entries = [...fresh.entries()];
    for (let i = 0; i < entries.length; i += CHUNK) {
      const part = entries.slice(i, i + CHUNK);
      await db.batch(part.map(([sku, price]) => ({ sql: `INSERT INTO competitor_prices (sku, price, fetched_at) VALUES (?, ?, ?)`, args: [sku, price, nowS] })), "write");
    }
    return { prices: fresh, source: "fresh" };
  }
  if (count > 0 && nowS - lastFetched < COMPETITOR_STALE_MAX_SECONDS) return { prices: await readCache(), source: "cache" };
  return { prices: null, source: "none" };
}

async function loadRows(): Promise<SellPriceRow[]> {
  const db = await ensureSchema();
  const r = await db.execute(`SELECT sku, price, product_type, sell_price FROM products WHERE price > 0 AND shopify_product_id IS NOT NULL AND shopify_product_id != ''`);
  return r.rows.map((x) => ({
    sku: String(x.sku),
    aosomPrice: Number(x.price),
    productType: String(x.product_type ?? ""),
    sellPrice: x.sell_price == null ? null : Number(x.sell_price),
  }));
}

async function saveChanges(changes: SellPriceChange[], at: Date): Promise<void> {
  const db = await ensureSchema();
  const t = Math.floor(at.getTime() / 1000);
  for (let i = 0; i < changes.length; i += CHUNK) {
    const part = changes.slice(i, i + CHUNK);
    await db.batch(
      part.flatMap((c) => [
        { sql: `UPDATE products SET sell_price = ? WHERE sku = ?`, args: [c.to, c.sku] },
        { sql: `INSERT INTO sell_price_history (sku, old_price, new_price, aosom_price, reason, detected_at) VALUES (?, ?, ?, ?, ?, ?)`, args: [c.sku, c.from, c.to, c.aosomPrice, c.reason, t] },
      ]),
      "write",
    );
  }
}

export function defaultSellPriceDeps(): SellPriceDeps {
  return { now: () => new Date(), getSetting, setSetting, loadRows, loadCompetitor, saveChanges };
}
