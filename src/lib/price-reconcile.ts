/**
 * Layers 2 and 4 — the two sweeps that keep Shopify equal to Turso.
 *
 * Layer 2 (hourly, `/api/cron/price-reconcile`): compare EVERY active Shopify variant
 * against the price Turso says it should have, and correct the difference. This is the
 * backstop for the daily push's 30-groups-per-day ceiling: instead of a random 1.9% of
 * pending diffs reaching the store, drift is drained hourly, in both directions.
 *
 * Layer 4 (after each daily sync): re-read a random 50 products and compare price AND
 * inventory. Layer 2 already corrects price, so this exists to catch what layer 2 cannot
 * see — inventory drift, and a systematic failure of the reconcile itself.
 *
 * Both are dependency-injected: the pure decision logic lives in price-protection.ts and
 * is unit-tested there; these functions only wire I/O to it.
 */
import {
  computeDrift,
  formatDriftAlert,
  formatSampleAlert,
  formatWriteFailureAlert,
  pickSample,
  writePriceVerified,
  POST_SYNC_SAMPLE_SIZE,
  PRICE_EPSILON,
  type DriftItem,
  type PriceWriteResult,
} from "@/lib/price-protection";

export interface ReconcileDeps {
  /** SKU → the price we intend to sell at (Turso products.price). */
  loadExpectedPrices: () => Promise<Map<string, number>>;
  /** Every active Shopify variant with its live price. */
  loadShopifyVariants: () => Promise<Array<{ sku: string; price: number; variantId: string }>>;
  writePrice: (variantId: string, price: number, oldPrice?: number) => Promise<void>;
  readVariant: (variantId: string) => Promise<{ price: number } | null>;
  notify: (type: string, title: string, message: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  /** Safety valve: never correct more than this in one run. */
  maxCorrections?: number;
}

export interface ReconcileResult {
  scanned: number;
  drifted: number;
  corrected: number;
  failed: number;
  deferred: number;
  items: DriftItem[];
  failures: PriceWriteResult[];
}

/**
 * Cap per run. Shopify Admin REST is ~2 req/s and each correction is a write plus a
 * verifying read, so 300 corrections is roughly 5 minutes of API time — sized to fit
 * inside the route's maxDuration with headroom. Anything beyond is deferred to the next
 * hour rather than risking a SIGKILL mid-write.
 */
export const MAX_CORRECTIONS_PER_RECONCILE = 300;

export async function runPriceReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const maxCorrections = deps.maxCorrections ?? MAX_CORRECTIONS_PER_RECONCILE;
  const [expected, variants] = await Promise.all([deps.loadExpectedPrices(), deps.loadShopifyVariants()]);

  const drift = computeDrift(expected, variants);
  const toFix = drift.slice(0, maxCorrections);
  const deferred = drift.length - toFix.length;

  const failures: PriceWriteResult[] = [];
  let corrected = 0;

  // SEQUENTIAL on purpose (faille C). Two variants of the same product written in
  // parallel race each other through Shopify's product-level write lock, and the loser
  // is silently dropped. It also keeps us under the 2 req/s Admin API limit.
  for (const item of toFix) {
    const res = await writePriceVerified(item.sku, item.variantId, item.expectedPrice, item.shopifyPrice, {
      writePrice: deps.writePrice,
      readVariant: deps.readVariant,
      sleep: deps.sleep,
    });
    if (res.ok) corrected++;
    else failures.push(res);
  }

  // Layer 3 — surface what could not be fixed.
  if (failures.length > 0) {
    const a = formatWriteFailureAlert(failures);
    await deps.notify("price_write_failed", a.title, a.message);
  }
  if (deferred > 0) {
    const a = formatDriftAlert(drift.slice(maxCorrections), "reconcile différé");
    await deps.notify("price_drift", a.title, a.message);
  }

  return { scanned: variants.length, drifted: drift.length, corrected, failed: failures.length, deferred, items: drift, failures };
}

// ─── Layer 4: post-sync sample verification ──────────────────────────

export interface SampleDeps {
  /** SKU → expected price + expected quantity, from Turso. */
  loadExpected: () => Promise<Map<string, { price: number; qty: number }>>;
  loadShopifyVariants: () => Promise<Array<{ sku: string; price: number; variantId: string; inventoryQuantity: number }>>;
  notify: (type: string, title: string, message: string) => Promise<unknown>;
  sampleSize?: number;
  rand?: () => number;
}

export interface SampleResult {
  sampled: number;
  priceDrift: DriftItem[];
  stockDrift: Array<{ sku: string; shopifyQty: number; expectedQty: number }>;
  alerted: boolean;
}

/**
 * Re-read a random sample after the daily sync and compare price AND inventory.
 *
 * Only samples SKUs present on both sides. Inventory is compared with a tolerance of 0,
 * but ONLY for variants Shopify actually tracks — a dropship variant with
 * `inventory_management: null` is sellable regardless of its stored quantity, so
 * comparing it produces pure noise (see the inventory-sweep notes in shopify-client.ts).
 */
export async function runPostSyncSample(deps: SampleDeps): Promise<SampleResult> {
  const size = deps.sampleSize ?? POST_SYNC_SAMPLE_SIZE;
  const [expected, variants] = await Promise.all([deps.loadExpected(), deps.loadShopifyVariants()]);

  const comparable = variants.filter((v) => v.sku && expected.has(v.sku));
  const sample = pickSample(comparable, size, deps.rand);

  const priceMap = new Map<string, number>();
  for (const v of sample) priceMap.set(v.sku, expected.get(v.sku)!.price);
  const priceDrift = computeDrift(priceMap, sample);

  const stockDrift: Array<{ sku: string; shopifyQty: number; expectedQty: number }> = [];
  for (const v of sample) {
    const want = expected.get(v.sku)!;
    if (Math.abs(v.inventoryQuantity - want.qty) > PRICE_EPSILON && v.inventoryQuantity !== want.qty) {
      stockDrift.push({ sku: v.sku, shopifyQty: v.inventoryQuantity, expectedQty: want.qty });
    }
  }

  let alerted = false;
  if (priceDrift.length > 0 || stockDrift.length > 0) {
    const a = formatSampleAlert(priceDrift, stockDrift, sample.length);
    await deps.notify("post_sync_sample", a.title, a.message);
    alerted = true;
  }

  return { sampled: sample.length, priceDrift, stockDrift, alerted };
}
