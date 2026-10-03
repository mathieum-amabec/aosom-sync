/**
 * Costway → Shopify importer (pilot). Same rules as the Aosom import: our own titles, handles and SKUs,
 * the supplier never shows. Two phases so a human can review before anything is written:
 *
 *   prepare  selects candidates, writes the French/English copy with the normal content generator and
 *            runs every gate (image, language, supplier-name leak). No Shopify write.
 *   apply    creates each prepared product as a DRAFT, links it in `costway_products` IMMEDIATELY (so
 *            the Aosom sweeps skip it), uploads neutral-named images, sets stock, and re-reads the
 *            product to prove nothing of the supplier is in it.
 *
 * Everything external is injected (`ImporterDeps`) so the flow is unit-tested without Shopify or an LLM.
 */
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { AosomMergedProduct, AosomVariant } from "@/types/aosom";
import type { GeneratedContent } from "@/lib/content-generator";
import { classifyCostway, KIND_PRODUCT_TYPE, SOURCE_TAG, type CostwayKind } from "./taxonomy";
import { costwaySellPrice, marginOf, sellableQty } from "./pricing";
import { assignInternalSkus, findCostwayLeaks, isInternalSku, neutralImageFilename } from "./identity";
import { stripSupplierBrands } from "@/lib/catalog-guard";

const MAX_IMAGES = 8;
const MIN_IMAGES = 5;

/** The merged-product grouping key must not carry the supplier name or item number. */
function opaqueGroupKey(itemNo: string): string {
  return "g" + createHash("sha256").update(`ameublo-direct|group|${itemNo}`).digest("hex").slice(0, 10);
}

// ── Candidates ──────────────────────────────────────────────────────────────────────────────────

export interface CandidateVariant {
  sku: string;
  color: string;
  feedPrice: number;
  priceDrop: number | null;
  promoTag: string;
  qty: number;
  caQty: number;
  usQty: number;
  images: string[];
}

export interface Candidate {
  itemNo: string;
  title: string;
  bodyHtml: string;
  category: string;
  kind: CostwayKind;
  variants: CandidateVariant[];
}

export interface SelectOptions {
  limit: number;
  /** A product needs at least one variant with this much Costway stock (hand-ordered: no thin stock). */
  minQty?: number;
  /** Sort: highest margin per sale first (Mat: "les produits avec plus de marges sont les plus intéressants"). */
  excludeItemNos?: string[];
}

/** Margin of the cheapest sellable variant — the figure used to rank candidates. */
export function candidateMargin(c: Candidate, minQty = 3): { dollars: number; pct: number; sell: number } {
  const sellable = c.variants.filter((v) => v.qty >= minQty);
  const pool = sellable.length ? sellable : c.variants;
  const v = pool.reduce((a, b) => (a.feedPrice <= b.feedPrice ? a : b));
  const sell = costwaySellPrice({ price: v.feedPrice, priceDrop: v.priceDrop, promoTag: v.promoTag });
  return { ...marginOf(sell, v.feedPrice), sell };
}

/** Where the stock sits: Canadian warehouse stock means a faster delivery for a hand-placed order. */
export function stockOrigin(c: Candidate): "CA" | "US" {
  return c.variants.some((v) => v.caQty > 0) ? "CA" : "US";
}

interface Row {
  sku: string; item_no: string; title: string; body_html: string | null; category: string | null; color: string | null;
  price: number | null; price_drop: number | null; promo_tag: string | null; in_stock: number; qty: number;
  ca_qty: number | null; us_qty: number | null; images: string; shopify_product_id: string | null;
}

export async function selectCandidates(db: Client, opts: SelectOptions): Promise<Candidate[]> {
  const minQty = opts.minQty ?? 10;
  const rows = (
    await db.execute({
      sql: `SELECT sku, item_no, title, body_html, category, color, price, price_drop, promo_tag, in_stock, qty, ca_qty, us_qty, images, shopify_product_id
            FROM costway_products
            WHERE removed_at IS NULL AND item_no IN (
              SELECT item_no FROM costway_products
              WHERE removed_at IS NULL AND in_stock = 1 AND qty >= ? AND price > 0
                AND (category LIKE 'Appliances > Climate Control Appliances > Dehumidifiers%' OR category LIKE 'Appliances > Washers & Dryers%'))`,
      args: [minQty],
    })
  ).rows as unknown as Row[];

  const byItem = new Map<string, Row[]>();
  for (const r of rows) byItem.set(r.item_no, [...(byItem.get(r.item_no) ?? []), r]);

  const out: Candidate[] = [];
  for (const [itemNo, group] of byItem) {
    if (opts.excludeItemNos?.includes(itemNo)) continue;
    if (group.some((r) => r.shopify_product_id)) continue; // already imported
    const first = group[0];
    const kind = classifyCostway(first.title, first.category ?? "");
    if (!kind) continue;
    const variants: CandidateVariant[] = group.map((r) => ({
      sku: r.sku,
      color: r.color ?? "",
      feedPrice: Number(r.price ?? 0),
      priceDrop: r.price_drop == null ? null : Number(r.price_drop),
      promoTag: r.promo_tag ?? "",
      qty: Number(r.qty ?? 0),
      caQty: Number(r.ca_qty ?? 0),
      usQty: Number(r.us_qty ?? 0),
      images: parseImages(r.images),
    }));
    if (variants.some((v) => !(v.feedPrice > 0))) continue;
    if (unionImages(variants).length < MIN_IMAGES) continue;
    out.push({ itemNo, title: first.title, bodyHtml: first.body_html ?? "", category: first.category ?? "", kind, variants });
  }
  out.sort((a, b) => candidateMargin(b, minQty).dollars - candidateMargin(a, minQty).dollars);
  return out.slice(0, opts.limit);
}

function parseImages(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.startsWith("http")) : [];
  } catch {
    return [];
  }
}

/** Product gallery: each variant's own photos, first variant first, de-duplicated, capped. */
export function unionImages(variants: CandidateVariant[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of variants) for (const u of v.images) if (!seen.has(u)) { seen.add(u); out.push(u); }
  return out.slice(0, MAX_IMAGES);
}

// ── Prepare ─────────────────────────────────────────────────────────────────────────────────────

export interface PreparedVariant {
  supplierSku: string;
  color: string;
  feedPrice: number;
  sellPrice: number;
  priceDropFloor: number | null;
  promoTag: string;
  qty: number;
  caQty: number;
  sellQty: number;
  /** This variant's own photos (its colour), used to attach the right photo to the right variant. */
  images: string[];
}

export interface PreparedItem {
  itemNo: string;
  kind: CostwayKind;
  productType: string;
  originalTitle: string;
  content: GeneratedContent;
  imageUrls: string[];
  variants: PreparedVariant[];
  stockOrigin: "CA" | "US";
  margin: { dollars: number; pct: number; sell: number };
  /** Anything that must be fixed or reviewed before apply. Empty = ready. */
  problems: string[];
}

export interface PrepareDeps {
  generate(product: AosomMergedProduct): Promise<GeneratedContent>;
  /** Reorders so pos-1 is a clean photo; outcome "no_alternative" means every candidate has an overlay. */
  guardImages(urls: string[]): Promise<{ images: string[]; outcome: string }>;
  qualityGates(images: string[], content: { titleFr: string; descriptionFr: string }): Promise<{ failures: string[] }>;
  cleanHtml(html: string): string;
}

/** Text the LLM sees about the variants must not carry supplier SKUs: stand-ins V1, V2… */
function toMerged(c: Candidate, cleanDescription: string, skus: string[], imageUrls: string[]): AosomMergedProduct {
  const variants: AosomVariant[] = c.variants.map((v, i) => ({
    sku: skus[i],
    price: costwaySellPrice({ price: v.feedPrice, priceDrop: v.priceDrop, promoTag: v.promoTag }),
    qty: v.qty,
    color: v.color,
    size: "",
    gtin: "",
    weight: 0,
    dimensions: { length: 0, width: 0, height: 0 },
    images: v.images,
    estimatedArrival: "",
    outOfStockExpected: "",
    packageNum: "",
    boxSize: "",
    boxWeight: "",
  }));
  return {
    groupKey: opaqueGroupKey(c.itemNo),
    // A title that names the supplier (4 do) must not reach the prompt.
    name: stripSupplierBrands(c.title).replace(/s+/g, " ").trim(),
    // The store brand: this lands in the `custom.brand_fr` metafield, and the supplier must not.
    brand: "Ameublo Direct",
    productType: KIND_PRODUCT_TYPE[c.kind],
    category: KIND_PRODUCT_TYPE[c.kind],
    description: cleanDescription,
    shortDescription: "",
    material: "",
    images: imageUrls,
    video: "",
    pdf: "",
    variants,
  };
}

/** Every customer-visible text field of a generated listing, for the leak gate. */
export function contentTexts(c: GeneratedContent): string[] {
  return [
    c.titleFr, c.titleEn, c.descriptionFr, c.descriptionEn, c.seoDescriptionFr, c.seoDescriptionEn,
    c.metaTitleFr, c.metaTitleEn, c.metaDescriptionFr, c.metaDescriptionEn, c.urlHandleFr, c.urlHandleEn, ...c.tags,
  ];
}

export async function prepareCandidate(c: Candidate, deps: PrepareDeps): Promise<PreparedItem> {
  const problems: string[] = [];
  const supplierSkus = c.variants.map((v) => v.sku);

  const guard = await deps.guardImages(unionImages(c.variants));
  if (guard.outcome === "no_alternative") problems.push("image_not_clean: every candidate photo carries an overlay");
  const imageUrls = guard.images;

  const merged = toMerged(c, deps.cleanHtml(c.bodyHtml), c.variants.map((_, i) => `V${i + 1}`), imageUrls);
  const content = await deps.generate(merged);

  const gates = await deps.qualityGates(imageUrls, content);
  for (const f of gates.failures) if (f !== "image_not_clean") problems.push(`gate:${f}`);
  for (const text of contentTexts(content)) {
    for (const leak of findCostwayLeaks(text, supplierSkus)) problems.push(`leak:${leak}`);
  }

  const variants: PreparedVariant[] = c.variants.map((v) => ({
    supplierSku: v.sku,
    color: v.color,
    feedPrice: v.feedPrice,
    sellPrice: costwaySellPrice({ price: v.feedPrice, priceDrop: v.priceDrop, promoTag: v.promoTag }),
    priceDropFloor: v.priceDrop,
    promoTag: v.promoTag,
    qty: v.qty,
    caQty: v.caQty,
    sellQty: sellableQty(v.qty),
    images: v.images,
  }));
  if (variants.some((v) => !Number.isFinite(v.sellPrice))) problems.push("price: unusable sell price");

  return {
    itemNo: c.itemNo,
    kind: c.kind,
    productType: KIND_PRODUCT_TYPE[c.kind],
    originalTitle: c.title,
    content,
    imageUrls,
    variants,
    stockOrigin: stockOrigin(c),
    margin: candidateMargin(c),
    problems: [...new Set(problems)],
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────

export interface CreatedProduct {
  id: string;
  handle: string;
  status: string;
  tags: string[];
  vendor: string;
  productType: string;
  title: string;
  bodyHtml: string;
  variants: Array<{ id: string; sku: string; inventoryItemId: string; option1: string | null }>;
  images: Array<{ id: string; src: string; alt: string | null }>;
}

export interface ApplyDeps {
  db: Client;
  now(): number;
  sleep(ms: number): Promise<void>;
  createProduct(merged: AosomMergedProduct, content: GeneratedContent): Promise<{ id: string; handle: string }>;
  downloadImage(url: string): Promise<string>; // base64
  uploadImage(productId: string, img: { attachment: string; filename: string; alt: string; position: number }): Promise<void>;
  getProduct(id: string): Promise<CreatedProduct>;
  attachVariantImages(created: CreatedProduct, merged: AosomMergedProduct): Promise<number>;
  trackInventory(inventoryItemId: string, qty: number): Promise<void>;
}

export interface ApplyResult {
  itemNo: string;
  ok: boolean;
  productId?: string;
  handle?: string;
  internalSkus?: string[];
  imagesUploaded?: number;
  warnings: string[];
  error?: string;
}

function sqlIn(n: number): string {
  return Array(n).fill("?").join(",");
}

/** Build the merged product with the REAL (internal) SKUs, from the prepared plan. */
export function mergedFromPrepared(p: PreparedItem, internalSkus: string[]): AosomMergedProduct {
  const variants: AosomVariant[] = p.variants.map((v, i) => ({
    sku: internalSkus[i],
    price: v.sellPrice,
    qty: v.sellQty,
    color: v.color,
    size: "",
    gtin: "",
    weight: 0,
    dimensions: { length: 0, width: 0, height: 0 },
    images: p.variants[i].images,
    estimatedArrival: "",
    outOfStockExpected: "",
    packageNum: "",
    boxSize: "",
    boxWeight: "",
  }));
  return {
    groupKey: opaqueGroupKey(p.itemNo),
    name: stripSupplierBrands(p.originalTitle).replace(/s+/g, " ").trim(),
    brand: "Ameublo Direct",
    productType: p.productType,
    category: p.productType,
    description: "",
    shortDescription: "",
    material: "",
    images: p.imageUrls,
    video: "",
    pdf: "",
    variants,
  };
}

export async function applyPrepared(p: PreparedItem, batch: string, deps: ApplyDeps): Promise<ApplyResult> {
  const warnings: string[] = [];
  const supplierSkus = p.variants.map((v) => v.supplierSku);
  try {
    if (p.problems.length) throw new Error(`not ready: ${p.problems.join("; ")}`);

    // Idempotency: never create a second product for an item that is already linked.
    const already = await deps.db.execute({
      sql: `SELECT COUNT(*) AS n FROM costway_products WHERE sku IN (${sqlIn(supplierSkus.length)}) AND shopify_product_id IS NOT NULL`,
      args: supplierSkus,
    });
    if (Number((already.rows[0] as unknown as { n: number }).n) > 0) throw new Error("already imported");

    const skuMap = await assignInternalSkus(supplierSkus);
    const internalSkus = supplierSkus.map((s) => skuMap.get(s) ?? "");
    if (internalSkus.some((s) => !isInternalSku(s))) throw new Error("internal SKU assignment failed");

    const merged = mergedFromPrepared(p, internalSkus);
    // Create WITHOUT images (fast, no 25s false-timeout): they are uploaded afterwards under neutral names.
    const created = await deps.createProduct(merged, p.content);

    // Link IMMEDIATELY — from this instant the Aosom sweeps skip the product.
    await deps.db.execute({
      sql: `UPDATE costway_products SET shopify_product_id = ?, shopify_handle = ?, import_batch = ?, imported_at = ?, import_status = 'draft'
            WHERE sku IN (${sqlIn(supplierSkus.length)})`,
      args: [created.id, created.handle, batch, deps.now(), ...supplierSkus],
    });
    for (let i = 0; i < supplierSkus.length; i++) {
      await deps.db.execute({ sql: `UPDATE costway_products SET sell_price = ? WHERE sku = ?`, args: [p.variants[i].sellPrice, supplierSkus[i]] });
    }

    // Images, neutral filenames, in order.
    let uploaded = 0;
    for (let i = 0; i < p.imageUrls.length; i++) {
      try {
        const attachment = await deps.downloadImage(p.imageUrls[i]);
        await deps.uploadImage(created.id, {
          attachment,
          filename: neutralImageFilename(internalSkus[0], i, p.imageUrls[i]),
          alt: p.content.titleFr,
          position: i + 1,
        });
        uploaded++;
      } catch (err) {
        warnings.push(`image ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await deps.sleep(550);
    }

    const full = await deps.getProduct(created.id);
    try {
      await deps.attachVariantImages(full, merged);
    } catch (err) {
      warnings.push(`variant photos: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Stock: tracked, quantity = what we are willing to sell (0 under the safety minimum).
    for (const v of full.variants) {
      const idx = internalSkus.indexOf(v.sku);
      if (idx < 0) { warnings.push(`variant ${v.sku}: not in plan`); continue; }
      try {
        await deps.trackInventory(v.inventoryItemId, p.variants[idx].sellQty);
      } catch (err) {
        warnings.push(`stock ${v.sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await deps.sleep(550);
    }

    // Final proof: nothing of the supplier anywhere in what Shopify holds.
    const final = await deps.getProduct(created.id);
    const surface = JSON.stringify({
      title: final.title, body: final.bodyHtml, handle: final.handle, tags: final.tags, vendor: final.vendor,
      type: final.productType, variants: final.variants, images: final.images,
    });
    const leaks = findCostwayLeaks(surface, supplierSkus);
    if (leaks.length) warnings.push(`LEAK in created product: ${leaks.join(", ")}`);
    if (final.status !== "draft") warnings.push(`status is ${final.status}, expected draft`);
    if (!final.tags.includes(SOURCE_TAG)) warnings.push(`missing tag ${SOURCE_TAG}`);
    if (final.vendor !== "Ameublo Direct") warnings.push(`vendor is ${final.vendor}`);
    if (final.variants.some((v) => !isInternalSku(v.sku))) warnings.push("a variant SKU is not an internal SKU");
    if (final.images.length !== p.imageUrls.length) warnings.push(`images: ${final.images.length}/${p.imageUrls.length}`);

    return { itemNo: p.itemNo, ok: true, productId: created.id, handle: created.handle, internalSkus, imagesUploaded: uploaded, warnings };
  } catch (err) {
    return { itemNo: p.itemNo, ok: false, warnings, error: err instanceof Error ? err.message : String(err) };
  }
}
