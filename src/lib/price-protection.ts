/**
 * Price protection — five layers between the Aosom feed and the live Shopify price.
 *
 * WHY THIS EXISTS (investigation 2026-09-02, SKU 830-821V80BK):
 * the daily Turso→Shopify push (`runShopifyPush`) applies at most
 * `SHOPIFY_PUSH_CHUNK_SIZE` (10) product groups per cron run, three runs a day = 30/day,
 * against 1,559 pending diffs — and its checkpoint is keyed on the date, so the 1,529
 * unprocessed groups are DISCARDED at midnight rather than drained. Prices reached the
 * store essentially at random. The 09:30 floor audit was silently repairing the damage,
 * but only in one direction (below-floor), so an Aosom price DROP could sit unapplied
 * forever and we would quietly stay more expensive than the supplier.
 *
 * The five layers, in the order they run:
 *
 *   1. WRITE-THEN-VERIFY  — every price write is read back and retried (this file).
 *   2. HOURLY RECONCILE   — /api/cron/price-reconcile drains drift Turso↔Shopify.
 *   3. DRIFT ALERTS       — any unresolved mismatch becomes a dashboard notification.
 *   4. POST-SYNC SAMPLE   — after each daily sync, 50 random products are re-read.
 *   5. SPIKE GUARD        — an Aosom increase >20% drafts the product for manual review
 *                           instead of silently repricing the storefront.
 *
 * Everything here is dependency-injected so the decision logic is unit-testable without a
 * network or a database. The pure functions (`isPriceSpike`, `computeDrift`,
 * `pickSample`) carry the rules; the orchestrators take their I/O as arguments.
 */
/** Cents, without float noise. Local twin of the helper in price-audit.ts. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ─── Tunables ────────────────────────────────────────────────────────

/** Attempts for a single price write (1 initial + 2 retries). */
export const PRICE_WRITE_ATTEMPTS = 3;

/** Backoff between write attempts, ms. Shopify Admin REST allows ~2 req/s. */
export const PRICE_WRITE_BACKOFF_MS = 700;

/**
 * A price is "the same" within this tolerance. Matches SYNC.PRICE_TOLERANCE: Shopify
 * stores prices as decimal strings, so a float round-trip can differ in the last cent.
 */
export const PRICE_EPSILON = 0.01;

/**
 * Aosom increase beyond this fraction drafts the product instead of repricing it.
 * 0.20 = +20%. An increase this large is usually a supplier data error or a product
 * being replaced, and pushing it live silently is how a storefront ends up with an
 * absurd price on a product people are actively browsing.
 */
export const PRICE_SPIKE_THRESHOLD = 0.2;

/** How many products the post-sync verification samples. */
export const POST_SYNC_SAMPLE_SIZE = 50;

// ─── Layer 5: spike detection (pure) ─────────────────────────────────

/**
 * True when `newPrice` is more than PRICE_SPIKE_THRESHOLD above `oldPrice`.
 *
 * Only increases trip this. A DROP is never held back: selling cheaper than the supplier
 * expects costs margin, but holding a drop costs sales AND leaves us above the Aosom
 * price, which is the exact failure this whole module exists to stop.
 */
export function isPriceSpike(oldPrice: number, newPrice: number): boolean {
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) return false;
  if (oldPrice <= 0 || newPrice <= 0) return false;
  if (newPrice <= oldPrice) return false;
  return (newPrice - oldPrice) / oldPrice > PRICE_SPIKE_THRESHOLD;
}

/** Percentage increase, rounded to one decimal. Negative for a drop. */
export function priceChangePercent(oldPrice: number, newPrice: number): number {
  if (!Number.isFinite(oldPrice) || oldPrice <= 0) return 0;
  return Math.round(((newPrice - oldPrice) / oldPrice) * 1000) / 10;
}

// ─── Layers 2 & 4: drift detection (pure) ────────────────────────────

export interface DriftItem {
  sku: string;
  variantId: string;
  shopifyPrice: number;
  expectedPrice: number;
  /** shopifyPrice - expectedPrice, rounded to cents. Negative = selling too cheap. */
  gap: number;
}

/**
 * Compare the price Turso says a SKU should have against what Shopify actually shows.
 *
 * `expected` maps SKU → the price we intend to sell at (Turso `products.price`, which is
 * the Aosom feed price under the 0% markup policy). Only SKUs present in BOTH sides are
 * compared: a Shopify variant with no Turso row is a manually-added product we must not
 * touch, and a Turso row with no Shopify variant is simply not imported yet.
 */
export function computeDrift(
  expected: Map<string, number>,
  shopifyVariants: Array<{ sku: string; price: number; variantId: string }>,
): DriftItem[] {
  const out: DriftItem[] = [];
  for (const v of shopifyVariants) {
    if (!v.sku) continue;
    const want = expected.get(v.sku);
    if (want == null || !Number.isFinite(want) || want <= 0) continue;
    const gap = round2(v.price - want);
    if (Math.abs(gap) > PRICE_EPSILON) {
      out.push({ sku: v.sku, variantId: v.variantId, shopifyPrice: round2(v.price), expectedPrice: round2(want), gap });
    }
  }
  // Worst underpricing first — that is where money is actively being lost.
  out.sort((a, b) => a.gap - b.gap);
  return out;
}

/**
 * Deterministic-when-seeded random sample, so the post-sync check covers a different 50
 * products every run but a test can pin the selection.
 */
export function pickSample<T>(items: T[], size: number, rand: () => number = Math.random): T[] {
  if (items.length <= size) return [...items];
  const copy = [...items];
  // Partial Fisher-Yates: only the first `size` slots need to be settled.
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, size);
}

// ─── Layer 1: write-then-verify ──────────────────────────────────────

export interface PriceWriteResult {
  sku: string;
  variantId: string;
  requested: number;
  /** The price Shopify reported on the verifying read, or null when it could not be read. */
  observed: number | null;
  ok: boolean;
  attempts: number;
  error?: string;
}

export interface PriceWriteDeps {
  writePrice: (variantId: string, price: number, oldPrice?: number) => Promise<void>;
  readVariant: (variantId: string) => Promise<{ price: number } | null>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Write a variant price, then READ IT BACK and confirm it stuck. Retries up to
 * PRICE_WRITE_ATTEMPTS.
 *
 * A 200 from Shopify's PUT means the request was accepted, not that the value persisted:
 * a concurrent write from the Shopify admin, a throttled retry, or an app that also
 * manages prices can all leave a different value stored. Before this, `applyToShopify`
 * marked the price_history row applied on the strength of the PUT alone — which is why
 * rows carried `applied_to_shopify = 1` for prices that were never actually live.
 *
 * A deleted variant (read returns null) fails immediately: retrying cannot fix it.
 */
export async function writePriceVerified(
  sku: string,
  variantId: string,
  price: number,
  oldPrice: number | undefined,
  deps: PriceWriteDeps,
): Promise<PriceWriteResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= PRICE_WRITE_ATTEMPTS; attempt++) {
    try {
      await deps.writePrice(variantId, price, oldPrice);
      const back = await deps.readVariant(variantId);
      if (back === null) {
        return { sku, variantId, requested: price, observed: null, ok: false, attempts: attempt, error: "variant not found on read-back (deleted?)" };
      }
      if (Math.abs(back.price - price) <= PRICE_EPSILON) {
        return { sku, variantId, requested: price, observed: round2(back.price), ok: true, attempts: attempt };
      }
      lastError = `read-back mismatch: sent ${price}, Shopify holds ${back.price}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < PRICE_WRITE_ATTEMPTS) await sleep(PRICE_WRITE_BACKOFF_MS);
  }

  return { sku, variantId, requested: price, observed: null, ok: false, attempts: PRICE_WRITE_ATTEMPTS, error: lastError };
}

// ─── Layer 3: dashboard alerts ───────────────────────────────────────

const money = (n: number) => `${n.toFixed(2)} $`;
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)} $`;

/** Notification body for a batch of unresolved drift. One row per SKU, worst first. */
export function formatDriftAlert(items: DriftItem[], contextLabel: string): { title: string; message: string } {
  const under = items.filter((i) => i.gap < 0);
  const over = items.filter((i) => i.gap > 0);
  const lines = items
    .slice(0, 20)
    .map((i) => `${i.sku} — Shopify ${money(i.shopifyPrice)} vs attendu ${money(i.expectedPrice)} (${signed(i.gap)})`);
  if (items.length > 20) lines.push(`… et ${items.length - 20} autre(s)`);
  return {
    title: `Écart de prix Turso ↔ Shopify — ${items.length} variante(s) [${contextLabel}]`,
    message:
      `${under.length} sous le prix attendu (perte de marge), ${over.length} au-dessus (perte de compétitivité).\n\n` +
      lines.join("\n"),
  };
}

/** Notification body for a price write that failed every retry. */
export function formatWriteFailureAlert(failures: PriceWriteResult[]): { title: string; message: string } {
  const lines = failures
    .slice(0, 20)
    .map((f) => `${f.sku} (variante ${f.variantId}) — voulu ${money(f.requested)}, ${f.observed == null ? "relecture impossible" : `Shopify tient ${money(f.observed)}`} · ${f.error ?? "?"}`);
  if (failures.length > 20) lines.push(`… et ${failures.length - 20} autre(s)`);
  return {
    title: `Écriture de prix NON confirmée — ${failures.length} variante(s)`,
    message:
      `Chaque écriture a été retentée ${PRICE_WRITE_ATTEMPTS} fois et relue ; le prix n'a pas pris.\n\n` +
      lines.join("\n"),
  };
}

/** Notification body for a supplier price spike held back for manual approval. */
export function formatSpikeAlert(
  items: Array<{ sku: string; shopifyId: string; oldPrice: number; newPrice: number }>,
): { title: string; message: string } {
  const lines = items.map(
    (i) => `${i.sku} — ${money(i.oldPrice)} → ${money(i.newPrice)} (${priceChangePercent(i.oldPrice, i.newPrice)} %) · produit ${i.shopifyId} mis en draft`,
  );
  return {
    title: `Hausse Aosom > ${Math.round(PRICE_SPIKE_THRESHOLD * 100)} % — ${items.length} produit(s) en attente d'approbation`,
    message:
      `Ces produits ont été mis en DRAFT plutôt que repricés en silence. Vérifie le prix fournisseur, ` +
      `puis republie-les (le prix sera poussé au prochain sync).\n\n` +
      lines.join("\n"),
  };
}

/** Notification body for the post-sync sample check. */
export function formatSampleAlert(
  priceDrift: DriftItem[],
  stockDrift: Array<{ sku: string; shopifyQty: number; expectedQty: number }>,
  sampled: number,
): { title: string; message: string } {
  const parts: string[] = [];
  if (priceDrift.length) {
    parts.push(
      `PRIX (${priceDrift.length}) :\n` +
        priceDrift.slice(0, 10).map((i) => `  ${i.sku} — Shopify ${money(i.shopifyPrice)} vs ${money(i.expectedPrice)} (${signed(i.gap)})`).join("\n"),
    );
  }
  if (stockDrift.length) {
    parts.push(
      `INVENTAIRE (${stockDrift.length}) :\n` +
        stockDrift.slice(0, 10).map((i) => `  ${i.sku} — Shopify ${i.shopifyQty} vs attendu ${i.expectedQty}`).join("\n"),
    );
  }
  return {
    title: `Vérification post-sync — ${priceDrift.length + stockDrift.length} écart(s) sur ${sampled} produits échantillonnés`,
    message: parts.join("\n\n") || "Aucun écart.",
  };
}
