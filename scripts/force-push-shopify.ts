#!/usr/bin/env tsx
/**
 * scripts/force-push-shopify.ts
 *
 * Force-push Shopify price drift recovery.
 *
 * Phase 2 cron has been timing out for ~12 days (Turso latency + Hobby plan
 * limitations), leaving the 74 imported products' Shopify prices out of sync
 * with the DB. This one-shot script corrects them directly.
 *
 * SCOPE — price only:
 *   ✅ Price per variant (DB price → Shopify)
 *   ❌ Inventory — dropship (inventory_management: null), Shopify doesn't track stock
 *   ❌ Archive — out-of-stock detection belongs to the diff-engine, not here
 *   ❌ Description / body_html — managed exclusively by the import pipeline
 *   ❌ Images — curated by import pipeline, raw Aosom URLs would overwrite them
 *
 * Idempotent: re-runnable, no-op when prices already match.
 * Dry-run by default — requires explicit --apply to write.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/force-push-shopify.ts           # dry-run
 *   npx tsx --env-file=.env.local scripts/force-push-shopify.ts --apply   # apply
 *
 * Reports written to scripts/reports/force-push-<timestamp>.json (gitignored).
 */

import { createClient } from "@libsql/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllShopifyProducts, updateShopifyVariantPrice } from "@/lib/shopify-client";
import type { ShopifyExistingProduct } from "@/types/sync";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Logger ──────────────────────────────────────────────────────────────────
// Pino-compatible structured JSON logger (pino not in dependencies).
type LogData = Record<string, unknown>;
function makeLogger(name: string) {
  const emit = (level: number, data: LogData | string, msg?: string) => {
    const [extra, message] =
      typeof data === "string" ? [{}, data] : [data, msg ?? ""];
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      name,
      ...extra,
      msg: message,
    });
    if (level >= 50) process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    info:  (data: LogData | string, msg?: string) => emit(30, data, msg),
    warn:  (data: LogData | string, msg?: string) => emit(40, data, msg),
    error: (data: LogData | string, msg?: string) => emit(50, data, msg),
    fatal: (data: LogData | string, msg?: string) => emit(60, data, msg),
  };
}
const log = makeLogger("force-push-shopify");

// ─── Types ────────────────────────────────────────────────────────────────────
interface DbProduct {
  sku: string;
  shopify_product_id: string;
  price: number;
  qty: number;
  name: string;
}

export interface PriceDiff {
  type: "price";
  sku: string;
  shopify_product_id: string;
  variant_id: string;
  db_price: number;
  shopify_price: number;
}

export interface MissingOnShopify {
  type: "missing_product" | "missing_variant";
  sku: string;
  shopify_product_id: string;
  reason?: string;
}

export type DiffEntry = PriceDiff | MissingOnShopify;

interface ReportData {
  mode: "dry-run" | "apply";
  diffs: DiffEntry[];
  applied: number;
  failed: number;
  errors: { sku: string; error: string }[];
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DRY_RUN = !process.argv.includes("--apply");
const PRICE_TOLERANCE = 0.01;
/** Delay between Shopify write calls — stays well within Shopify's 2 req/s bucket. */
const APPLY_DELAY_MS = 100;
const DIFF_SAMPLE_SIZE = 10;

// ─── Env validation ───────────────────────────────────────────────────────────
// Fail fast with a clear message rather than cryptic downstream errors.
function validateEnv() {
  const missing: string[] = [];
  if (!process.env.TURSO_DATABASE_URL) missing.push("TURSO_DATABASE_URL");
  if (!process.env.TURSO_AUTH_TOKEN) missing.push("TURSO_AUTH_TOKEN");
  if (!process.env.SHOPIFY_ACCESS_TOKEN) missing.push("SHOPIFY_ACCESS_TOKEN");
  if (missing.length > 0) {
    log.fatal({ missing }, "Missing required env vars — run with --env-file=.env.local");
    process.exit(1);
  }
}

// ─── DB ────────────────────────────────────────────────────────────────────────
async function loadImportedProducts(): Promise<DbProduct[]> {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });
  try {
    const result = await db.execute(
      `SELECT sku, shopify_product_id, price, qty, name
       FROM products
       WHERE shopify_product_id IS NOT NULL`
    );
    const rows = result.rows.map((row) => ({
      sku: String(row.sku ?? ""),
      shopify_product_id: String(row.shopify_product_id ?? ""),
      price: Number(row.price),
      qty: Number(row.qty) || 0,
      name: String(row.name ?? ""),
    }));
    // Guard: skip products with no valid price (NULL or 0) — pushing $0 to Shopify would be damaging.
    const valid = rows.filter((r) => r.price > 0);
    if (valid.length < rows.length) {
      log.warn({ skipped: rows.length - valid.length }, "Skipped products with invalid price (NULL or 0)");
    }
    return valid;
  } finally {
    db.close();
  }
}

// ─── Diff ─────────────────────────────────────────────────────────────────────
/**
 * Compare DB products against fetched Shopify state.
 *
 * variant_id is NOT persisted in the DB — it is resolved at runtime by matching
 * the DB row's sku against the Shopify product's variants[].sku. This is the
 * same approach used by Phase 2 (getAllProductsAsAosom → computeDiffs).
 */
export function computePriceDiffs(
  dbProducts: DbProduct[],
  shopifyById: Map<string, ShopifyExistingProduct>
): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  for (const db of dbProducts) {
    const shopifyProduct = shopifyById.get(db.shopify_product_id);

    if (!shopifyProduct) {
      log.warn(
        { sku: db.sku, shopify_product_id: db.shopify_product_id },
        "Product not found on Shopify"
      );
      diffs.push({ type: "missing_product", sku: db.sku, shopify_product_id: db.shopify_product_id });
      continue;
    }

    const variant = shopifyProduct.variants.find((v) => v.sku === db.sku);

    if (!variant) {
      const available = shopifyProduct.variants.map((v) => v.sku).join(", ") || "(none)";
      log.warn(
        { sku: db.sku, shopify_product_id: db.shopify_product_id, available_skus: available },
        "Variant not found by SKU in Shopify product"
      );
      diffs.push({
        type: "missing_variant",
        sku: db.sku,
        shopify_product_id: db.shopify_product_id,
        reason: `Available SKUs: ${available}`,
      });
      continue;
    }

    if (Math.abs(variant.price - db.price) > PRICE_TOLERANCE) {
      diffs.push({
        type: "price",
        sku: db.sku,
        shopify_product_id: db.shopify_product_id,
        variant_id: variant.variantId,
        db_price: db.price,
        shopify_price: variant.price,
      });
    }
  }

  return diffs;
}

// ─── Report ───────────────────────────────────────────────────────────────────
export function writeReport(data: ReportData): string {
  const reportsDir = join(__dirname, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = join(reportsDir, `force-push-${timestamp}.json`);
  writeFileSync(
    filename,
    JSON.stringify({ timestamp: new Date().toISOString(), ...data }, null, 2),
    "utf8"
  );
  log.info({ file: filename }, "Report written");
  return filename;
}

// ─── Apply (exported for unit tests) ─────────────────────────────────────────
export async function applyPriceDiffs(
  diffs: PriceDiff[],
  opts: { delayMs?: number } = {}
): Promise<{ applied: number; failed: number; errors: { sku: string; error: string }[] }> {
  const delayMs = opts.delayMs ?? APPLY_DELAY_MS;
  let applied = 0;
  let failed = 0;
  const errors: { sku: string; error: string }[] = [];

  for (const diff of diffs) {
    try {
      await updateShopifyVariantPrice(diff.variant_id, diff.db_price);
      applied++;
      log.info(
        { sku: diff.sku, from: diff.shopify_price, to: diff.db_price },
        "Price updated"
      );
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ sku: diff.sku, error: message });
      log.error({ sku: diff.sku, err: message }, "Failed to update price");
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return { applied, failed, errors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();
  log.info({ mode: DRY_RUN ? "dry-run" : "apply" }, "Force-push started");

  // 1. Load the 74 imported products from DB
  const dbProducts = await loadImportedProducts();
  log.info({ count: dbProducts.length }, "Loaded DB products");

  // 2. Fetch all Shopify products (1 paginated call), then build lookup map
  log.info("Fetching all Shopify products…");
  const allShopify = await fetchAllShopifyProducts();

  const shopifyIdSet = new Set(dbProducts.map((p) => p.shopify_product_id));
  const shopifyById = new Map(
    allShopify
      .filter((s) => shopifyIdSet.has(s.shopifyId))
      .map((s) => [s.shopifyId, s])
  );
  log.info(
    { total_shopify: allShopify.length, matched: shopifyById.size },
    "Shopify fetch complete"
  );

  // 3. Compute diffs
  const diffs = computePriceDiffs(dbProducts, shopifyById);

  const priceDiffs = diffs.filter((d): d is PriceDiff => d.type === "price");
  const warnings = diffs.filter((d) => d.type !== "price");

  log.info(
    {
      total_db: dbProducts.length,
      shopify_matched: shopifyById.size,
      price_diffs: priceDiffs.length,
      warnings: warnings.length,
      sample: priceDiffs.slice(0, DIFF_SAMPLE_SIZE).map((d) => ({
        sku: d.sku,
        db_price: d.db_price,
        shopify_price: d.shopify_price,
        delta: +(d.db_price - d.shopify_price).toFixed(2),
      })),
    },
    "Diff summary"
  );

  if (DRY_RUN) {
    log.info("Dry-run complete — re-run with --apply to apply corrections");
    try { writeReport({ mode: "dry-run", diffs, applied: 0, failed: 0, errors: [] }); }
    catch (e) { log.warn({ err: String(e) }, "Report write failed (dry-run results were not persisted)"); }
    return;
  }

  // 4. Apply — push price corrections to Shopify
  const { applied, failed, errors } = await applyPriceDiffs(priceDiffs);

  log.info({ applied, failed, total: priceDiffs.length }, "Apply complete");
  // Report write failure is non-fatal after a successful apply — log a warning but don't mask the apply result.
  try { writeReport({ mode: "apply", diffs, applied, failed, errors }); }
  catch (e) { log.warn({ err: String(e) }, "Report write failed — apply results were logged above"); }
}

// Guard: only auto-execute when run as a script, not when imported by tests.
// In ESM, import.meta.url is the module URL; process.argv[1] is the entry script.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "Fatal error");
    process.exit(1);
  });
}
