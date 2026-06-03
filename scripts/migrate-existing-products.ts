#!/usr/bin/env tsx
/**
 * scripts/migrate-existing-products.ts
 *
 * Retroactively apply product-naming-v2 to products ALREADY imported on Shopify:
 * brand-free titles + native SEO metafields. Reconstructs each product's Aosom
 * source data from the Turso `products` table, regenerates content with the same
 * generateProductContent() the import pipeline uses, then (write mode) updates the
 * Shopify product title + SEO metafields.
 *
 * ┌─ ABSOLUTE RULE ──────────────────────────────────────────────────────────┐
 * │ NEVER touch the existing URL handle. It is SEO-indexed. The PUT payload    │
 * │ never includes `handle`; updating only `title` does not change an existing │
 * │ product's handle on Shopify.                                               │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Modes (env):
 *   DRY_RUN  (default "true")  — generate content, write a CSV, NO Shopify writes.
 *   LIMIT    (default all)     — cap the number of Shopify products processed.
 *
 * Rate limits: 2s between Claude calls; in write mode, well under Shopify's 2 req/s.
 *
 * Usage:
 *   DRY_RUN=true  LIMIT=50 tsx --env-file=.env.local scripts/migrate-existing-products.ts
 *   DRY_RUN=false           tsx --env-file=.env.local scripts/migrate-existing-products.ts
 *
 * CSV report → scripts/reports/migrate-dry-run-<timestamp>.csv (gitignored).
 */

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "@/lib/database";
import { generateProductContent } from "@/lib/content-generator";
import { mergeVariants } from "@/lib/variant-merger";
import { shopifyFetch } from "@/lib/shopify-client";
import type { AosomProduct, AosomMergedProduct } from "@/types/aosom";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN !== "false"; // default true — must opt out explicitly
const LIMIT = process.env.LIMIT ? Math.max(1, parseInt(process.env.LIMIT, 10)) : Infinity;
const CLAUDE_DELAY_MS = 2000; // 2s between Claude API calls
const SHOPIFY_DELAY_MS = 500; // 2 req/s ceiling for the PUT in write mode
// Resume: skip every shopify_id already present in this CSV (e.g. an interrupted
// run's own output). Lets a re-run continue without re-touching done products.
const RESUME_CSV = process.env.RESUME_CSV || "";
// Abort if too many products fail in a row — a sign of a network/API outage
// rather than per-product data issues.
const MAX_CONSECUTIVE_ERRORS = 10;
// Apply already-reviewed content straight from a prior dry-run CSV (no Claude calls).
const APPLY_FROM_CSV = process.env.APPLY_FROM_CSV || "";
// Limit the apply to the first N rows (canary). 0 = all.
const CANARY = process.env.CANARY ? Math.max(1, parseInt(process.env.CANARY, 10)) : 0;

// Supplier brands that must NOT appear in a v2 title (used for the audit metric).
const SUPPLIER_BRANDS = [
  "Outsunny", "HOMCOM", "HomCom", "Aosom", "Vinsetto", "Pawhut", "PawHut",
  "Soozier", "Qaba", "ShopEZ", "Wikinger", "Portland", "Aousthop", "kleankin", "DURHAND",
];
const BRAND_RE = new RegExp(`\\b(${SUPPLIER_BRANDS.join("|")})\\b`, "i");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), name: "migrate", msg, ...extra }) + "\n");
}

// ─── Shopify (paginated GET + count) ─────────────────────────────────────────
interface ShopifyProductLite {
  id: string;
  handle: string;
  title: string;
  variants: { sku: string }[];
}

function nextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function shopifyProductCount(): Promise<number> {
  const resp = await shopifyFetch("/products/count.json");
  if (!resp.ok) throw new Error(`count.json -> ${resp.status}`);
  return (await resp.json()).count as number;
}

/** Yields Shopify products (id, handle, title, variant SKUs), stopping at `limit`. */
async function* iterateShopifyProducts(limit: number): AsyncGenerator<ShopifyProductLite> {
  let pageInfo: string | null = null;
  let yielded = 0;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,handle,title,variants" });
    if (pageInfo) params.set("page_info", pageInfo);
    const resp = await shopifyFetch(`/products.json?${params}`);
    if (!resp.ok) throw new Error(`products.json -> ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    for (const p of data.products as Record<string, unknown>[]) {
      yield {
        id: String(p.id),
        handle: String(p.handle ?? ""),
        title: String(p.title ?? ""),
        variants: ((p.variants as Record<string, unknown>[]) ?? []).map((v) => ({ sku: String(v.sku ?? "") })),
      };
      if (++yielded >= limit) return;
    }
    pageInfo = nextPageInfo(resp.headers.get("Link"));
  } while (pageInfo);
}

// ─── DB → AosomProduct index (no last_seen filter; covers all imported rows) ──
function dbRowToAosom(o: Record<string, unknown>): AosomProduct {
  const images = [o.image1, o.image2, o.image3, o.image4, o.image5, o.image6, o.image7].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  return {
    sku: String(o.sku ?? ""),
    name: String(o.name ?? ""),
    price: Number(o.price ?? 0),
    qty: Number(o.qty ?? 0),
    color: String(o.color ?? ""),
    size: String(o.size ?? ""),
    productType: String(o.product_type ?? ""),
    images,
    video: String(o.video ?? ""),
    description: String(o.description ?? ""),
    shortDescription: String(o.short_description ?? ""),
    material: String(o.material ?? ""),
    gtin: String(o.gtin ?? ""),
    weight: Number(o.weight ?? 0),
    estimatedArrival: String(o.estimated_arrival ?? ""),
    outOfStockExpected: String(o.out_of_stock_expected ?? ""),
    dimensions: { length: 0, width: 0, height: 0 },
    brand: "",
    category: "",
    psin: "",
    sin: "",
    pdf: "",
    packageNum: "",
    boxSize: "",
    boxWeight: "",
  };
}

interface DbIndex {
  byShopifyId: Map<string, AosomProduct[]>;
  bySku: Map<string, AosomProduct>;
}

async function buildDbIndex(): Promise<DbIndex> {
  const db = await ensureSchema();
  const res = await db.execute(
    `SELECT sku, name, price, qty, color, size, product_type,
            image1, image2, image3, image4, image5, image6, image7,
            video, description, short_description, material, gtin, weight,
            estimated_arrival, out_of_stock_expected, shopify_product_id
       FROM products`,
  );
  const byShopifyId = new Map<string, AosomProduct[]>();
  const bySku = new Map<string, AosomProduct>();
  for (const row of res.rows) {
    const o = row as unknown as Record<string, unknown>;
    const prod = dbRowToAosom(o);
    if (prod.sku) bySku.set(prod.sku, prod);
    const spid = o.shopify_product_id ? String(o.shopify_product_id) : "";
    if (spid) {
      const arr = byShopifyId.get(spid);
      if (arr) arr.push(prod);
      else byShopifyId.set(spid, [prod]);
    }
  }
  return { byShopifyId, bySku };
}

/** Resolve the DB Aosom rows backing a Shopify product (by id, then by SKU). */
function resolveRows(p: ShopifyProductLite, idx: DbIndex): AosomProduct[] {
  const byId = idx.byShopifyId.get(p.id);
  if (byId && byId.length) return byId;
  const rows: AosomProduct[] = [];
  for (const v of p.variants) {
    const r = v.sku && idx.bySku.get(v.sku);
    if (r) rows.push(r);
  }
  return rows;
}

/** When rows span >1 merged group, pick the one best matching the Shopify SKUs. */
function pickMerged(groups: AosomMergedProduct[], p: ShopifyProductLite): AosomMergedProduct {
  if (groups.length === 1) return groups[0];
  const pSkus = new Set(p.variants.map((v) => v.sku));
  let best = groups[0];
  let bestScore = -1;
  for (const g of groups) {
    const score = g.variants.filter((v) => pSkus.has(v.sku)).length;
    if (score > bestScore) { bestScore = score; best = g; }
  }
  return best;
}

// ─── Shopify write (title + SEO metafields; NEVER the handle) ────────────────
interface NewContent {
  titleFr: string;
  titleEn: string;
  metaTitleFr: string;
  metaDescriptionFr: string;
  metaDescriptionEn: string;
}

async function applyToShopify(productId: string, c: NewContent): Promise<void> {
  const metafields = [
    { namespace: "global", key: "title_tag", value: c.metaTitleFr, type: "single_line_text_field" },
    { namespace: "global", key: "description_tag", value: c.metaDescriptionFr, type: "single_line_text_field" },
    { namespace: "custom", key: "title_en", value: c.titleEn, type: "single_line_text_field" },
    { namespace: "custom", key: "meta_description_fr", value: c.metaDescriptionFr, type: "single_line_text_field" },
    { namespace: "custom", key: "meta_description_en", value: c.metaDescriptionEn, type: "single_line_text_field" },
  ].filter((m) => typeof m.value === "string" && m.value.trim() !== ""); // empty value → Shopify 422s the whole PUT

  // NOTE: `handle` is deliberately absent. Updating `title` alone never changes
  // an existing product's handle on Shopify.
  const body = { product: { id: Number(productId), title: c.titleFr, metafields } };
  const resp = await shopifyFetch(`/products/${productId}.json`, { method: "PUT", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`PUT /products/${productId} -> ${resp.status} ${await resp.text()}`);
}

// ─── CSV ─────────────────────────────────────────────────────────────────────
function csvCell(v: string): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

/** Shopify IDs already present in a prior CSV — skipped on resume. */
function loadResumeIds(path: string): Set<string> {
  if (!path) return new Set();
  try {
    const text = readFileSync(path, "utf8");
    const rows = parseCsv(text, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
    const ids = new Set<string>();
    for (const r of rows) if (r.shopify_id) ids.add(String(r.shopify_id).trim());
    return ids;
  } catch (err) {
    log("resume_csv_error", { path, err: err instanceof Error ? err.message : String(err) });
    return new Set();
  }
}

interface MigrationRecord {
  shopify_id: string;
  sku: string;
  handle: string;
  title_avant: string;
  title_fr_apres: string;
  title_en_apres: string;
  meta_title_fr_apres: string;
  meta_description_fr_apres: string;
}

// ─── Apply mode: write already-reviewed content straight from a dry-run CSV ───
// No Claude calls — applies exactly the titles/metas already reviewed. The dry-run
// CSV has no meta_description_en column, so custom.meta_description_en is NOT set
// by this path (empty values are filtered out before the PUT). Handle is never sent.
async function applyFromCsv(): Promise<void> {
  const allRows = parseCsv(readFileSync(APPLY_FROM_CSV, "utf8"), {
    columns: true, skip_empty_lines: true, relax_column_count: true,
  }) as Record<string, string>[];
  const resumeIds = loadResumeIds(RESUME_CSV);
  const limit = CANARY > 0 ? CANARY : allRows.length;
  const rows = allRows.slice(0, limit).filter((r) => !resumeIds.has(String(r.shopify_id).trim()));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportsDir = join(__dirname, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `migrate-apply-${stamp}.csv`);
  writeFileSync(reportPath, "shopify_id,status\n", "utf8");

  log("apply_from_csv_start", {
    source: APPLY_FROM_CSV, total: allRows.length, canary: CANARY || "all",
    resume_skipped: resumeIds.size, to_apply: rows.length, dry_run: DRY_RUN, report: reportPath,
  });

  let updated = 0, errors = 0, consecutiveErrors = 0, aborted = false;
  for (const r of rows) {
    const id = String(r.shopify_id).trim();
    const content: NewContent = {
      titleFr: r.title_fr_apres ?? "",
      titleEn: r.title_en_apres ?? "",
      metaTitleFr: r.meta_title_fr_apres ?? "",
      metaDescriptionFr: r.meta_description_fr_apres ?? "",
      metaDescriptionEn: "", // not captured in the dry-run CSV → filtered out of the PUT
    };
    if (DRY_RUN) { log("would_apply", { shopify_id: id, title: content.titleFr }); continue; }
    try {
      await applyToShopify(id, content);
      updated++; consecutiveErrors = 0;
      appendFileSync(reportPath, `"${id}","ok"\n`, "utf8");
      log("applied", { progress: `${updated}/${rows.length}`, shopify_id: id, handle: r.handle });
      await sleep(SHOPIFY_DELAY_MS);
    } catch (err) {
      errors++; consecutiveErrors++;
      appendFileSync(reportPath, `"${id}","error"\n`, "utf8");
      log("apply_error", { shopify_id: id, err: err instanceof Error ? err.message : String(err), consecutive: consecutiveErrors });
      if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) { aborted = true; break; }
    }
    if (updated % 25 === 0 && updated > 0) log("progress", { applied: `${updated}/${rows.length}`, errors });
  }

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(` MIGRATION APPLY-FROM-CSV — ${DRY_RUN ? "PREVIEW (no writes)" : "WRITE MODE"}${aborted ? "  [ABORTED: error streak]" : ""}`);
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`Source CSV: ${APPLY_FROM_CSV}`);
  console.log(`À appliquer: ${rows.length}${CANARY ? ` (canary ${CANARY})` : ""}   Mis à jour: ${updated}   Erreurs: ${errors}   Resume-skippés: ${resumeIds.size}`);
  if (aborted) console.log(`⚠ ARRÊT: >${MAX_CONSECUTIVE_ERRORS} erreurs consécutives. Relançable avec RESUME_CSV=${reportPath}`);
  console.log(`Note: custom.meta_description_en NON appliqué (absent du CSV dry-run). Handle jamais touché.`);
  console.log(`Report: ${reportPath}`);
  console.log("══════════════════════════════════════════════════════════════════");
  log("done_apply", { updated, errors, aborted, to_apply: rows.length });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (APPLY_FROM_CSV) { await applyFromCsv(); return; }
  log("start", { dry_run: DRY_RUN, limit: LIMIT === Infinity ? "all" : LIMIT });

  const idx = await buildDbIndex();
  log("db_index_built", { products_rows: idx.bySku.size, shopify_linked: idx.byShopifyId.size });

  const totalShopify = await shopifyProductCount();
  log("shopify_count", { total_products: totalShopify });

  // CSV is opened up front and appended row-by-row, so a crash/hang persists
  // every product processed so far — no final dump that loses everything on failure.
  const CSV_COLUMNS: (keyof MigrationRecord)[] = [
    "shopify_id", "sku", "handle", "title_avant", "title_fr_apres",
    "title_en_apres", "meta_title_fr_apres", "meta_description_fr_apres",
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportsDir = join(__dirname, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const csvPath = join(reportsDir, `migrate-dry-run-${stamp}.csv`);
  writeFileSync(csvPath, CSV_COLUMNS.join(",") + "\n", "utf8");
  log("csv_opened", { path: csvPath });

  const resumeIds = loadResumeIds(RESUME_CSV);
  if (RESUME_CSV) log("resume_loaded", { path: RESUME_CSV, skip_ids: resumeIds.size });

  const records: MigrationRecord[] = [];
  let processed = 0, skipped = 0, errors = 0, updated = 0, resumeSkipped = 0;
  let consecutiveErrors = 0, aborted = false;

  for await (const p of iterateShopifyProducts(LIMIT)) {
    if (resumeIds.has(p.id)) { resumeSkipped++; continue; }

    const rows = resolveRows(p, idx);
    if (!rows.length) {
      skipped++;
      log("skip_no_db_match", { shopify_id: p.id, title: p.title.slice(0, 60) });
      continue;
    }

    let content;
    try {
      const merged = pickMerged(mergeVariants(rows), p);
      content = await generateProductContent(merged);
    } catch (err) {
      errors++; consecutiveErrors++;
      log("generate_error", { shopify_id: p.id, err: err instanceof Error ? err.message : String(err), consecutive: consecutiveErrors });
      if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) { aborted = true; break; }
      await sleep(CLAUDE_DELAY_MS);
      continue;
    }

    const record: MigrationRecord = {
      shopify_id: p.id,
      sku: rows[0].sku,
      handle: p.handle,
      title_avant: p.title,
      title_fr_apres: content.titleFr,
      title_en_apres: content.titleEn,
      meta_title_fr_apres: content.metaTitleFr,
      meta_description_fr_apres: content.metaDescriptionFr,
    };
    records.push(record);
    // Persist this product immediately (one CSV row), before any Shopify write.
    appendFileSync(csvPath, CSV_COLUMNS.map((k) => csvCell(String(record[k]))).join(",") + "\n", "utf8");

    if (!DRY_RUN) {
      try {
        await applyToShopify(p.id, content);
        updated++; consecutiveErrors = 0;
        log("updated", { progress: `${updated}/${totalShopify}`, shopify_id: p.id, handle: p.handle });
        await sleep(SHOPIFY_DELAY_MS);
      } catch (err) {
        errors++; consecutiveErrors++;
        log("shopify_update_error", { shopify_id: p.id, err: err instanceof Error ? err.message : String(err), consecutive: consecutiveErrors });
        if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) { aborted = true; break; }
      }
    } else {
      consecutiveErrors = 0; // dry-run: a successfully generated product resets the streak
    }

    processed++;
    if (processed % 25 === 0) log("progress", { done: `${processed}/${totalShopify}`, skipped, errors, updated });
    await sleep(CLAUDE_DELAY_MS); // 2s between Claude calls
  }

  if (aborted) log("aborted", { reason: `>${MAX_CONSECUTIVE_ERRORS} consecutive errors`, processed, updated, errors });
  log("csv_finalized", { path: csvPath, rows: records.length });

  // ─── Analysis (ÉTAPE 2) ───────────────────────────────────────────────────
  const stillBrand = records.filter((r) => BRAND_RE.test(r.title_fr_apres));
  const estSeconds = totalShopify * (CLAUDE_DELAY_MS / 1000);
  const fmt = (s: number) => `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}min`;

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(` MIGRATION ${DRY_RUN ? "DRY-RUN — NO Shopify writes" : "APPLY — WRITE MODE"}${aborted ? "  [ABORTED: error streak]" : ""}`);
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`Shopify products total: ${totalShopify}`);
  if (!DRY_RUN) console.log(`Mis à jour (Shopify): ${updated}`);
  console.log(`Traités (contenu généré): ${processed}   Skippés (pas de match DB): ${skipped}   Resume-skippés: ${resumeSkipped}   Erreurs: ${errors}`);
  if (aborted) console.log(`⚠ ARRÊT: >${MAX_CONSECUTIVE_ERRORS} erreurs consécutives — vérifier le réseau/API. Relançable avec RESUME_CSV=${csvPath}`);
  if (csvPath) console.log(`CSV: ${csvPath}`);

  console.log("\n── First 10: title BEFORE → AFTER (FR) ───────────────────────────");
  records.slice(0, 10).forEach((r, i) => {
    console.log(`\n[${i + 1}] handle (unchanged): ${r.handle}`);
    console.log(`    AVANT : ${r.title_avant}`);
    console.log(`    APRÈS : ${r.title_fr_apres}`);
    if (BRAND_RE.test(r.title_fr_apres)) console.log(`    ⚠ contient encore une marque`);
  });

  console.log("\n── Audit ─────────────────────────────────────────────────────────");
  console.log(`Titres APRÈS contenant encore une marque fournisseur: ${stillBrand.length}/${records.length}`);
  stillBrand.slice(0, 10).forEach((r) => console.log(`   • ${r.title_fr_apres}`));
  console.log(`\nEstimation temps total (tous les produits): ~${fmt(estSeconds)}  (${totalShopify} × ${CLAUDE_DELAY_MS / 1000}s/appel Claude)`);
  console.log("══════════════════════════════════════════════════════════════════");

  log("done", { processed, skipped, resumeSkipped, errors, updated, aborted, still_brand: stillBrand.length });
}

main().catch((err) => {
  log("fatal", { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
