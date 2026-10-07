/**
 * Live gate for a post candidate. The catalog DB can be stale (its price is the supplier's, not
 * the store's — the storefront price lives on Shopify), so a product only goes into a post if
 * Shopify says it is active, it is lifestyle-verified with a clean position-1 photo, and it has a
 * real price. Anything else is dropped: the picker moves on to the next candidate.
 */
import { resolveProductFields } from "@/lib/selectors/shopify-product";
import { stripSupplierBrands } from "@/lib/catalog-guard";
import type { Candidate, LiveProduct } from "./types";

/** A rabais is only shown from 10 % up (store rule) and only when Shopify itself carries it. */
export const MIN_DISCOUNT_RATIO = 1.1;

/** "Fold-out Convertible Office Desk, Wall Mount Computer Desk…" → "Fold-out Convertible Office Desk". */
export function shortEnglishTitle(nameEn: string): string {
  const cleaned = stripSupplierBrands(nameEn).replace(/\s+/g, " ").trim();
  const first = cleaned.split(/\s*[,|;]\s*|\s+with\s+|\s+w\/\s*/i)[0] || cleaned;
  if (first.length <= 64) return first;
  const cut = first.slice(0, 61);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).trimEnd()}…`; // whole words only
}

function cap(title: string, n = 70): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

export type GateFailure = "no_shopify_id" | "no_stock" | "shopify_error" | "not_active" | "no_handle" | "no_lifestyle" | "no_price" | "no_title";

/**
 * `allowPlainPhoto`: accept the clean Shopify position-1 photo (white background) when the product
 * has no verified lifestyle photo yet. Only the new-arrivals format uses it — fresh imports are
 * never verified yet, so without it that format could never run.
 */
export async function checkProduct(c: Candidate, allowPlainPhoto = false): Promise<{ product: LiveProduct } | { fail: GateFailure }> {
  if (!c.shopifyProductId) return { fail: "no_shopify_id" };
  if (c.stock <= 0) return { fail: "no_stock" };
  let f;
  try {
    f = await resolveProductFields(c.shopifyProductId);
  } catch {
    return { fail: "shopify_error" }; // never post on guesswork
  }
  if (f.status !== "active") return { fail: "not_active" };
  if (!f.handle) return { fail: "no_handle" };
  const photo = f.lifestyle.verified && f.lifestyle.primaryImageUrl ? f.lifestyle.primaryImageUrl : allowPlainPhoto ? f.images[0] ?? null : null;
  if (!photo) return { fail: "no_lifestyle" };
  const price = Number(f.price);
  if (!Number.isFinite(price) || price <= 0) return { fail: "no_price" };
  const compareRaw = f.compareAtPrice == null ? NaN : Number(f.compareAtPrice);
  const compareAt = Number.isFinite(compareRaw) && compareRaw >= price * MIN_DISCOUNT_RATIO ? compareRaw : null;
  const titleFr = cap(stripSupplierBrands(f.titleFr || ""));
  if (!titleFr) return { fail: "no_title" };
  return {
    product: {
      sku: c.sku,
      shopifyProductId: c.shopifyProductId,
      titleFr,
      titleEn: shortEnglishTitle(c.nameEn),
      price,
      compareAt,
      handle: f.handle,
      imageUrl: photo,
      productType: c.productType,
    },
  };
}

export async function verifyProduct(c: Candidate): Promise<LiveProduct | null> {
  const r = await checkProduct(c);
  return "product" in r ? r.product : null;
}

/** Verify candidates in order until `want` pass (the Shopify calls are throttled, so stop early). */
export async function verifyUntil(
  candidates: Candidate[],
  want: number,
  skip: Set<string> = new Set(),
  accept: (p: LiveProduct, picked: LiveProduct[]) => boolean = () => true,
  tag = "",
  allowPlainPhoto = false,
): Promise<LiveProduct[]> {
  const out: LiveProduct[] = [];
  const seenImages = new Set<string>();
  const fails: Record<string, number> = {};
  let tried = 0;
  for (const c of candidates) {
    if (out.length >= want) break;
    if (skip.has(c.sku)) {
      fails.cooldown = (fails.cooldown ?? 0) + 1;
      continue;
    }
    tried++;
    const r = await checkProduct(c, allowPlainPhoto);
    if (!("product" in r)) {
      fails[r.fail] = (fails[r.fail] ?? 0) + 1;
      continue;
    }
    const p = r.product;
    if (seenImages.has(p.imageUrl)) {
      fails.same_photo = (fails.same_photo ?? 0) + 1; // two colours of one product share a photo
      continue;
    }
    if (!accept(p, out)) {
      fails.rejected_by_format = (fails.rejected_by_format ?? 0) + 1;
      continue;
    }
    seenImages.add(p.imageUrl);
    out.push(p);
  }
  console.log(`[semaine] ${tag || "verify"}: ${candidates.length} candidats, ${tried} vérifiés, ${out.length}/${want} retenus ${JSON.stringify(fails)}`);
  return out;
}
