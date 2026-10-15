/**
 * Production wiring for sell-price-sync.ts, plus the readers the price writers and checkers share.
 */
import { ensureSchema, getSetting, setSetting } from "@/lib/database";
import { fetchCompetitorPrices } from "@/lib/competitor-prices";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { effectiveSellPrice } from "@/lib/pricing";
import { computeSellPrice } from "@/lib/sell-price-rule";
import { referencePrice } from "@/lib/compare-at";
import { loadCompareAtSources } from "@/lib/price-history-db";
import { SYNC } from "@/lib/config";
import { discountCap, parsePricingMode, PRICING_MODE_KEY, type SellPriceChange, type SellPriceDeps, type SellPriceRow, type CompetitorSnapshot } from "@/lib/sell-price-sync";

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

/**
 * The crossed price currently shown on the storefront, per SKU. Imported lazily: compare-at-db pulls in the Shopify
 * client, which itself imports this module. An incomplete listing aborts the run (no change is safer than a cap that
 * silently misses the displayed discounts).
 */
async function loadLiveCompareAt(): Promise<Map<string, number>> {
  const { loadAllLiveVariants } = await import("@/lib/compare-at-db");
  const live = await loadAllLiveVariants();
  if (live.length < 500) throw new Error(`live variant listing incomplete (${live.length}): sell-price run aborted`);
  const m = new Map<string, number>();
  for (const v of live) if (v.compareAtPrice != null && v.compareAtPrice > 0) m.set(v.sku, v.compareAtPrice);
  return m;
}

async function loadRows(): Promise<SellPriceRow[]> {
  const db = await ensureSchema();
  const r = await db.execute(`SELECT sku, price, product_type, sell_price FROM products WHERE price > 0 AND shopify_product_id IS NOT NULL AND shopify_product_id != ''`);
  // A product with a real discount keeps it: its sell price is capped so that it stays at least MIN_DISCOUNT below its
  // reference price (see compare-at.ts) and below the crossed price already shown on the storefront.
  const sources = await loadCompareAtSources();
  const liveCompareAt = await loadLiveCompareAt();
  const nowS = Math.floor(Date.now() / 1000);
  const keep = 1 - SYNC.MIN_DISCOUNT_DISPLAY_PERCENT / 100;
  const costs = await loadFeedCosts();
  return r.rows.map((x) => {
    const sku = String(x.sku);
    const aosomPrice = Number(x.price);
    const src = sources.get(sku);
    const ref = src ? referencePrice(aosomPrice, src.steps, src.firstSeenAt, nowS) : null;
    return {
      sku,
      aosomPrice,
      productType: String(x.product_type ?? ""),
      sellPrice: x.sell_price == null ? null : Number(x.sell_price),
      cost: costs.get(sku) ?? null,
      maxPrice: discountCap(aosomPrice, [ref, liveCompareAt.get(sku)], keep),
    };
  });
}

/**
 * SKU -> our unit cost (wholesale price + delivery fee) from today's feed. An unreachable feed gives an empty map: the
 * rule then falls back to the tiered markup instead of failing the run.
 */
async function loadFeedCosts(): Promise<Map<string, number>> {
  try {
    const feed = await fetchAosomCatalog();
    const m = new Map<string, number>();
    for (const p of feed) if (typeof p.cost === "number" && p.cost > 0) m.set(p.sku, p.cost);
    return m;
  } catch {
    return new Map();
  }
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

/**
 * Import rule: a product is created at the price the sell-price rule gives it, not at the Aosom price to be raised a day
 * later. Cost comes from today's feed, the competitor price from the cached snapshot. Only while `pricing_mode` is live;
 * any failure returns nothing and the caller falls back to the Aosom price (an import is never blocked by pricing).
 */
export async function priceNewVariants(variants: ReadonlyArray<{ sku: string; price: number }>, productType: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (variants.length === 0) return out;
  try {
    if (parsePricingMode(await getSetting(PRICING_MODE_KEY)) !== "live") return out;
    const costs = await loadFeedCosts();
    const db = await ensureSchema();
    const upper = variants.map((v) => v.sku.toUpperCase());
    const comp = await db.execute({ sql: `SELECT sku, price FROM competitor_prices WHERE UPPER(sku) IN (${upper.map(() => "?").join(",")})`, args: upper });
    const competitor = new Map(comp.rows.map((r) => [String(r.sku).toUpperCase(), Number(r.price)]));
    const changes: SellPriceChange[] = [];
    for (const v of variants) {
      const res = computeSellPrice({ aosomPrice: v.price, productType, cost: costs.get(v.sku) ?? null, competitorPrice: competitor.get(v.sku.toUpperCase()) ?? null });
      if (!Number.isFinite(res.price) || res.price <= v.price + 0.004) continue;
      out.set(v.sku, res.price);
      changes.push({ sku: v.sku, from: null, to: res.price, aosomPrice: v.price, reason: res.reason });
    }
    if (changes.length > 0) await saveChanges(changes, new Date());
  } catch {
    out.clear();
  }
  return out;
}

export function defaultSellPriceDeps(): SellPriceDeps {
  return { now: () => new Date(), getSetting, setSetting, loadRows, loadCompetitor, saveChanges };
}
