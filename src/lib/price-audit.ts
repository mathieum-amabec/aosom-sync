/**
 * Price-floor audit + auto-correction. Compares the live Shopify selling price of every
 * variant against `products.price` — the Aosom feed price, which the sync force-pushes to
 * Shopify and which we treat as the FLOOR. A Shopify price below that floor means the
 * storefront is selling under the Aosom price (lost markup / potential loss).
 *
 * Detection (`computePriceFloorViolations`) is a pure function (DB- and network-free) so it
 * is unit-testable. `runPriceAudit()` wires it to Turso + the Shopify API. The correction
 * step (`correctViolations`) is dependency-injected (push + record callbacks) so it is also
 * unit-testable without network/DB; `runPriceAuditAndCorrect()` wires it to the real Shopify
 * variant-price update and `price_history`.
 */
import { setSetting, getProductsForPriceAudit, recordFloorCorrection } from "@/lib/database";
import { fetchAllShopifyProducts, updateShopifyVariantPrice } from "@/lib/shopify-client";
import { targetSellPrice } from "@/lib/pricing";

/** settings key holding the last audit summary the dashboard reads. */
export const PRICE_AUDIT_SETTING = "price_audit_result";
/** Cap on items persisted to settings (the full list is returned by the endpoint). */
export const PRICE_AUDIT_TOP_N = 20;
/**
 * Max corrections pushed to Shopify in a single run. The cron has maxDuration=300s and each
 * correction is a sequential Shopify PUT (25s timeout, 429 backoff), so an unbounded backlog
 * — e.g. the first run after deploy, or a sync regression — could exhaust the budget and die
 * mid-loop with no persisted summary. We push the worst-gap variants first (most underpriced =
 * most lost margin) and defer the rest to the next daily run, which drains the backlog over days.
 */
export const MAX_CORRECTIONS_PER_RUN = 200;

export interface PriceAuditItem {
  sku: string;
  shopify_price: number;
  aosom_price: number;
  /** shopify_price - aosom_price, rounded to cents. Negative = below floor. */
  gap: number;
  /** Live Shopify variant id, needed to push the correction. Absent if unmatched. */
  variantId?: string;
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
 * exact-match prices, which is the normal force-pushed state). The variant id is carried
 * through to each below-floor item so the correction step can push the fix.
 */
export function computePriceFloorViolations(
  aosom: Map<string, number>,
  shopifyVariants: Array<{ sku: string; price: number; variantId?: string }>,
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
      const item: PriceAuditItem = { sku, shopify_price: round2(v.price), aosom_price: round2(floor), gap };
      if (v.variantId) item.variantId = v.variantId; // omit when absent so tests stay strict
      items.push(item);
    }
  }

  items.sort((a, b) => a.gap - b.gap); // worst (most negative) first
  return { total, below_floor: items.length, items };
}

/** Run the full detection pass against Turso + the live Shopify catalog (no writes). */
export async function runPriceAudit(): Promise<PriceAuditResult> {
  const [catalog, shopifyProducts] = await Promise.all([
    getProductsForPriceAudit(),
    fetchAllShopifyProducts(),
  ]);
  const aosom = new Map<string, number>();
  for (const p of catalog) aosom.set(p.sku, p.price);

  const variants = shopifyProducts.flatMap((p) =>
    p.variants.map((v) => ({ sku: v.sku, price: v.price, variantId: v.variantId })),
  );
  return computePriceFloorViolations(aosom, variants);
}

// ─── Auto-correction ────────────────────────────────────────────────

export type CorrectionStatus = "corrected" | "failed";

export interface PriceCorrection {
  sku: string;
  /** null when the violation could not be matched to a Shopify variant id. */
  variantId: string | null;
  /** The below-floor price we found live on Shopify. */
  shopify_price: number;
  /** The Aosom floor. */
  aosom_price: number;
  /** The price we pushed (the floor — targetSellPrice of the Aosom price). */
  corrected_price: number;
  status: CorrectionStatus;
  /** Failure reason, present only when status === "failed". */
  error?: string;
}

export interface CorrectionDeps {
  /** Push a corrected price to a Shopify variant. Throws on API failure. */
  pushPrice: (variantId: string, price: number, oldPrice: number) => Promise<void>;
  /** Persist the correction to price_history. `applied` reflects the Shopify push outcome. */
  recordCorrection: (entry: {
    sku: string;
    oldPrice: number;
    newPrice: number;
    applied: boolean;
  }) => Promise<void>;
}

/**
 * Correct each below-floor violation: push the floor price to Shopify and log it to
 * price_history (change_type='floor_correction'). Dependency-injected so it is unit-testable.
 * Recording is best-effort — a successful Shopify push is NOT downgraded to "failed" just
 * because the history write threw (the live store is the source of truth that matters).
 */
export async function correctViolations(
  items: PriceAuditItem[],
  deps: CorrectionDeps,
): Promise<PriceCorrection[]> {
  const corrections: PriceCorrection[] = [];

  for (const item of items) {
    const target = targetSellPrice(item.aosom_price);
    const corrected_price = Number.isFinite(target) ? round2(target) : item.aosom_price;
    const base = {
      sku: item.sku,
      variantId: item.variantId ?? null,
      shopify_price: item.shopify_price,
      aosom_price: item.aosom_price,
      corrected_price,
    };

    const safeRecord = async (applied: boolean) => {
      try {
        await deps.recordCorrection({
          sku: item.sku,
          oldPrice: item.shopify_price,
          newPrice: corrected_price,
          applied,
        });
      } catch (err) {
        console.error(`[price-audit] failed to record floor_correction for ${item.sku}:`, err);
      }
    };

    if (!item.variantId) {
      // Below floor but no live variant to push to — record the unresolved violation.
      corrections.push({ ...base, status: "failed", error: "missing Shopify variant id" });
      await safeRecord(false);
      continue;
    }
    if (!Number.isFinite(target) || corrected_price <= 0) {
      // Should not happen (floor > 0 is guaranteed by detection), but never push a bad price.
      corrections.push({ ...base, status: "failed", error: "invalid floor price" });
      await safeRecord(false);
      continue;
    }

    try {
      await deps.pushPrice(item.variantId, corrected_price, item.shopify_price);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      corrections.push({ ...base, status: "failed", error: msg });
      await safeRecord(false);
      continue;
    }

    corrections.push({ ...base, status: "corrected" });
    await safeRecord(true); // push already succeeded — record is best-effort
  }

  return corrections;
}

export interface AuditAndCorrectResult extends PriceAuditResult {
  corrections: PriceCorrection[];
  /** Below-floor variants successfully re-priced on Shopify. */
  corrected: number;
  /** Below-floor variants whose correction failed (need manual attention). */
  failed: number;
  /** Below-floor variants NOT attempted this run (over the per-run cap); next run drains them. */
  deferred: number;
}

/**
 * Run the audit AND immediately push corrections for the below-floor variants, worst-gap
 * first, up to MAX_CORRECTIONS_PER_RUN. Any overflow is reported as `deferred` and picked up
 * by the next daily run (it stays below-floor until then, so it is re-detected).
 */
export async function runPriceAuditAndCorrect(
  maxPerRun = MAX_CORRECTIONS_PER_RUN,
): Promise<AuditAndCorrectResult> {
  const audit = await runPriceAudit();
  const toCorrect = audit.items.slice(0, maxPerRun); // items are already sorted worst-gap first
  const deferred = audit.below_floor - toCorrect.length;
  if (deferred > 0) {
    console.warn(
      `[price-audit] ${audit.below_floor} below-floor variants exceed the per-run cap (${maxPerRun}); deferring ${deferred} to the next run`,
    );
  }
  const corrections = await correctViolations(toCorrect, {
    pushPrice: (variantId, price, oldPrice) => updateShopifyVariantPrice(variantId, price, oldPrice),
    recordCorrection: (entry) => recordFloorCorrection(entry),
  });
  const corrected = corrections.filter((c) => c.status === "corrected").length;
  const failed = corrections.length - corrected;
  return { ...audit, corrections, corrected, failed, deferred };
}

export interface PriceAuditSummaryItem {
  sku: string;
  shopify_price: number;
  aosom_price: number;
  gap: number;
  corrected_price: number;
  status: CorrectionStatus;
  error?: string;
}

export interface PriceAuditSummary {
  auditedAt: number; // epoch seconds
  total: number;
  belowFloor: number;
  corrected: number;
  failed: number;
  /** Below-floor variants over the per-run cap, deferred to the next run. */
  deferred: number;
  topItems: PriceAuditSummaryItem[];
}

/**
 * Persist a compact summary the dashboard alert reads cheaply (no Shopify fetch on load).
 * Failed corrections are surfaced first in the capped top-N — they are the actionable ones.
 */
export async function persistPriceAudit(result: AuditAndCorrectResult, nowEpoch: number): Promise<void> {
  const ordered = [...result.corrections].sort((a, b) =>
    a.status === b.status ? 0 : a.status === "failed" ? -1 : 1,
  );
  const summary: PriceAuditSummary = {
    auditedAt: nowEpoch,
    total: result.total,
    belowFloor: result.below_floor,
    corrected: result.corrected,
    failed: result.failed,
    deferred: result.deferred,
    topItems: ordered.slice(0, PRICE_AUDIT_TOP_N).map((c) => ({
      sku: c.sku,
      shopify_price: c.shopify_price,
      aosom_price: c.aosom_price,
      gap: round2(c.shopify_price - c.aosom_price),
      corrected_price: c.corrected_price,
      status: c.status,
      ...(c.error ? { error: c.error } : {}),
    })),
  };
  await setSetting(PRICE_AUDIT_SETTING, JSON.stringify(summary));
}
