/**
 * Price-floor audit. Compares the live Shopify selling price of every variant against
 * `products.price` — the Aosom feed price, which the sync force-pushes to Shopify and which
 * we treat as the FLOOR. A Shopify price below that floor means the storefront is selling
 * under the Aosom price (lost markup / potential loss). The audit detects that drift.
 *
 * The comparison itself is a pure function (DB- and network-free) so it is unit-testable;
 * `runPriceAudit()` wires it to Turso + the Shopify API.
 */
import { setSetting, getProductsForPriceAudit } from "@/lib/database";
import { fetchAllShopifyProducts } from "@/lib/shopify-client";

/** settings key holding the last audit summary the dashboard reads. */
export const PRICE_AUDIT_SETTING = "price_audit_result";
/** Cap on items persisted to settings (the full list is returned by the endpoint). */
export const PRICE_AUDIT_TOP_N = 20;

export interface PriceAuditItem {
  sku: string;
  shopify_price: number;
  aosom_price: number;
  /** shopify_price - aosom_price, rounded to cents. Negative = below floor. */
  gap: number;
}

export interface PriceAuditResult {
  /** Variants compared (matched by SKU on both Shopify and the Aosom catalog). */
  total: number;
  /** How many of those are priced strictly below the Aosom floor. */
  below_floor: number;
  /** The below-floor variants, worst gap first. */
  items: PriceAuditItem[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure comparison. `aosom` maps SKU → Aosom floor price; `shopifyVariants` are the live
 * Shopify variants. Only SKUs present in BOTH are compared. A variant counts as below-floor
 * when its price is strictly below the floor after rounding to cents (avoids float noise on
 * exact-match prices, which is the normal force-pushed state).
 */
export function computePriceFloorViolations(
  aosom: Map<string, number>,
  shopifyVariants: Array<{ sku: string; price: number }>,
): PriceAuditResult {
  let total = 0;
  const items: PriceAuditItem[] = [];
  const seen = new Set<string>();

  for (const v of shopifyVariants) {
    const sku = (v.sku || "").trim();
    if (!sku || seen.has(sku)) continue; // skip blank/duplicate SKUs
    const floor = aosom.get(sku);
    if (floor == null || floor <= 0) continue; // not in the Aosom catalog (or no price) → not auditable
    seen.add(sku);
    total++;
    const gap = round2(v.price - floor);
    if (gap < 0) {
      items.push({ sku, shopify_price: round2(v.price), aosom_price: round2(floor), gap });
    }
  }

  items.sort((a, b) => a.gap - b.gap); // worst (most negative) first
  return { total, below_floor: items.length, items };
}

/** Run the full audit against Turso + the live Shopify catalog. */
export async function runPriceAudit(): Promise<PriceAuditResult> {
  const [catalog, shopifyProducts] = await Promise.all([
    getProductsForPriceAudit(),
    fetchAllShopifyProducts(),
  ]);
  const aosom = new Map<string, number>();
  for (const p of catalog) aosom.set(p.sku, p.price);

  const variants = shopifyProducts.flatMap((p) => p.variants.map((v) => ({ sku: v.sku, price: v.price })));
  return computePriceFloorViolations(aosom, variants);
}

export interface PriceAuditSummary {
  auditedAt: number; // epoch seconds
  total: number;
  belowFloor: number;
  topItems: PriceAuditItem[];
}

/** Persist a compact summary the dashboard alert reads cheaply (no Shopify fetch on load). */
export async function persistPriceAudit(result: PriceAuditResult, nowEpoch: number): Promise<void> {
  const summary: PriceAuditSummary = {
    auditedAt: nowEpoch,
    total: result.total,
    belowFloor: result.below_floor,
    topItems: result.items.slice(0, PRICE_AUDIT_TOP_N),
  };
  await setSetting(PRICE_AUDIT_SETTING, JSON.stringify(summary));
}
