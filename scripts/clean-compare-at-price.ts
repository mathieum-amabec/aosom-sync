#!/usr/bin/env tsx
/**
 * scripts/clean-compare-at-price.ts
 *
 * One-shot retroactive cleanup of invalid / sub-threshold compare_at_price
 * values already set on Shopify variants.
 *
 * The daily sync used to set compare_at_price on ANY price drop (even 1%),
 * which produced fake "sales" and a batch of corrupted values (compare_at
 * far below the actual price). The feature/discount-threshold change fixes
 * this going forward, but only re-touches a variant on its next price change.
 * This script cleans the existing state in one pass.
 *
 * A variant's compare_at_price is CLEARED when:
 *   - compare_at_price <= price            (invalid / corrupted), OR
 *   - real discount < MIN_DISCOUNT_DISPLAY_PERCENT (default 10%)
 * Variants with a genuine discount >= the threshold are KEPT untouched.
 *
 * SCOPE — compare_at_price only:
 *   ✅ Sets compare_at_price = null on targeted variants
 *   ❌ Never touches price, inventory, images, or any other field
 *
 * Read-only by default. Requires DRY_RUN=false to write.
 * Idempotent: re-runnable, no-op once the store is clean.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/clean-compare-at-price.ts                 # dry-run (default)
 *   DRY_RUN=false npx tsx --env-file=.env.local scripts/clean-compare-at-price.ts   # apply
 *
 * Report written to scripts/reports/clean-compare-at-<timestamp>.json (gitignored).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shopifyFetch } from "@/lib/shopify-client";
import { SYNC } from "@/lib/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Logger (matches force-push-shopify.ts) ────────────────────────────────────
type LogData = Record<string, unknown>;
function makeLogger(name: string) {
  const emit = (level: number, data: LogData | string, msg?: string) => {
    const [extra, message] = typeof data === "string" ? [{}, data] : [data, msg ?? ""];
    const line = JSON.stringify({ level, time: new Date().toISOString(), name, ...extra, msg: message });
    if (level >= 50) process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    info: (data: LogData | string, msg?: string) => emit(30, data, msg),
    warn: (data: LogData | string, msg?: string) => emit(40, data, msg),
    error: (data: LogData | string, msg?: string) => emit(50, data, msg),
    fatal: (data: LogData | string, msg?: string) => emit(60, data, msg),
  };
}
const log = makeLogger("clean-compare-at-price");

// ─── Constants ──────────────────────────────────────────────────────────────
// Default to dry-run; only an explicit DRY_RUN=false enables writes.
const DRY_RUN = process.env.DRY_RUN !== "false";
const THRESHOLD_PCT = SYNC.MIN_DISCOUNT_DISPLAY_PERCENT;
/** 500ms between writes => max 2 req/s, well inside Shopify's REST bucket. */
const APPLY_DELAY_MS = 500;
const SAMPLE_SIZE = 10;

// ─── Types ────────────────────────────────────────────────────────────────────
interface VariantRow {
  variantId: string;
  productId: string;
  product: string;
  sku: string;
  price: number;
  compareAt: number; // only populated rows (compare_at_price != null) are kept
  pct: number; // real discount %, can be negative for corrupted data
  reason: "invalid" | "below_threshold";
}

interface ReportData {
  mode: "dry-run" | "apply";
  thresholdPct: number;
  totalVariants: number;
  withCompareAt: number;
  keep: number;
  clearTargets: VariantRow[];
  applied: number;
  failed: number;
  errors: { variantId: string; sku: string; error: string }[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function nextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? m[1] : null;
}

function validateEnv() {
  if (!process.env.SHOPIFY_ACCESS_TOKEN) {
    log.fatal("Missing SHOPIFY_ACCESS_TOKEN — run with --env-file=.env.local");
    process.exit(1);
  }
}

// ─── Fetch (raw — keeps compare_at_price, which fetchAllShopifyProducts strips) ──
async function fetchVariantsWithCompareAt(): Promise<{ rows: VariantRow[]; totalVariants: number }> {
  const rows: VariantRow[] = [];
  let totalVariants = 0;
  let pageInfo: string | null = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,title,variants" });
    if (pageInfo) params.set("page_info", pageInfo);

    const res = await shopifyFetch(`/products.json?${params}`);
    if (!res.ok) {
      throw new Error(`products.json failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      products?: { id: number; title: string; variants?: { id: number; sku: string; price: string; compare_at_price: string | null }[] }[];
    };

    for (const p of data.products ?? []) {
      for (const v of p.variants ?? []) {
        totalVariants++;
        if (v.compare_at_price == null) continue;
        const compareAt = parseFloat(v.compare_at_price);
        const price = parseFloat(v.price);
        if (!Number.isFinite(compareAt)) continue;
        // pct = real discount. compareAt <= 0 or <= price => invalid (pct <= 0).
        const pct = compareAt > 0 ? ((compareAt - price) / compareAt) * 100 : -Infinity;
        if (pct >= THRESHOLD_PCT) continue; // genuine discount — keep
        rows.push({
          variantId: String(v.id),
          productId: String(p.id),
          product: p.title,
          sku: v.sku || "",
          price,
          compareAt,
          pct,
          reason: compareAt <= price ? "invalid" : "below_threshold",
        });
      }
    }

    pageInfo = nextPageInfo(res.headers.get("link"));
    pages++;
  } while (pageInfo);

  log.info({ pages, totalVariants, clearTargets: rows.length }, "Fetch complete");
  return { rows, totalVariants };
}

// ─── Apply (exported for tests) ────────────────────────────────────────────────
export async function clearCompareAt(
  targets: VariantRow[],
  opts: { delayMs?: number } = {},
): Promise<{ applied: number; failed: number; errors: { variantId: string; sku: string; error: string }[] }> {
  const delayMs = opts.delayMs ?? APPLY_DELAY_MS;
  let applied = 0;
  let failed = 0;
  const errors: { variantId: string; sku: string; error: string }[] = [];

  for (const t of targets) {
    try {
      const res = await shopifyFetch(`/variants/${t.variantId}.json`, {
        method: "PUT",
        body: JSON.stringify({ variant: { id: Number(t.variantId), compare_at_price: null } }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      applied++;
      log.info({ sku: t.sku, variantId: t.variantId, was: t.compareAt, pct: +t.pct.toFixed(2) }, "compare_at_price cleared");
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ variantId: t.variantId, sku: t.sku, error: message });
      log.error({ sku: t.sku, variantId: t.variantId, err: message }, "Failed to clear compare_at_price");
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return { applied, failed, errors };
}

// ─── Report ─────────────────────────────────────────────────────────────────
function writeReport(data: ReportData): string {
  const reportsDir = join(__dirname, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = join(reportsDir, `clean-compare-at-${timestamp}.json`);
  writeFileSync(filename, JSON.stringify({ timestamp: new Date().toISOString(), ...data }, null, 2), "utf8");
  log.info({ file: filename }, "Report written");
  return filename;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();
  log.info({ mode: DRY_RUN ? "dry-run" : "apply", thresholdPct: THRESHOLD_PCT }, "clean-compare-at-price started");

  const { rows, totalVariants } = await fetchVariantsWithCompareAt();

  const invalid = rows.filter((r) => r.reason === "invalid");
  const belowThreshold = rows.filter((r) => r.reason === "below_threshold");
  const worst = [...rows].sort((a, b) => a.pct - b.pct).slice(0, SAMPLE_SIZE);

  log.info(
    {
      total_variants: totalVariants,
      to_clear: rows.length,
      invalid_compare_at_le_price: invalid.length,
      below_threshold: belowThreshold.length,
      threshold_pct: THRESHOLD_PCT,
      worst: worst.slice(0, 5).map((w) => ({ sku: w.sku, was: w.compareAt, price: w.price, pct: +w.pct.toFixed(2) })),
    },
    "Cleanup summary",
  );

  if (DRY_RUN) {
    log.info("DRY RUN — no writes. Re-run with DRY_RUN=false to clear targeted compare_at_price.");
    try {
      writeReport({ mode: "dry-run", thresholdPct: THRESHOLD_PCT, totalVariants, withCompareAt: rows.length, keep: 0, clearTargets: rows, applied: 0, failed: 0, errors: [] });
    } catch (e) {
      log.warn({ err: String(e) }, "Report write failed (dry-run not persisted)");
    }
    return;
  }

  const { applied, failed, errors } = await clearCompareAt(rows);
  log.info({ applied, failed, total: rows.length }, "Apply complete");
  try {
    writeReport({ mode: "apply", thresholdPct: THRESHOLD_PCT, totalVariants, withCompareAt: rows.length, keep: 0, clearTargets: rows, applied, failed, errors });
  } catch (e) {
    log.warn({ err: String(e) }, "Report write failed — apply results were logged above");
  }
}

// Auto-execute only when run as a script, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    log.fatal({ err: err instanceof Error ? err.message : String(err) }, "Fatal error");
    process.exit(1);
  });
}
