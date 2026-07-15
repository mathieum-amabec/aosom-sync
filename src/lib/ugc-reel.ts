/**
 * Homepage "Voyez-le chez vous" UGC video reel data source.
 *
 * Picks the 5 most-in-stock products that have a clean CA/US customer unboxing
 * video (see `getUgcVideoCandidates`) and enriches each with its curated FR + EN
 * titles, price, PDP handle, and a clean cdn.shopify.com hero image. Titles come
 * from Shopify (curated), never from `products.name` (raw English Aosom title,
 * forbidden in client-facing content). Consumed by `GET /api/ugc-videos`.
 */
import { getUgcVideoCandidates } from "@/lib/database";
import { resolveProductFields } from "@/lib/selectors/shopify-product";
import { shopifyFetch } from "@/lib/shopify-client";

export interface UgcReelItem {
  sku: string;
  /** Curated FR title (live Shopify product title). */
  titleFr: string;
  /** Curated EN title (custom.title_en metafield; FR title when absent). */
  titleEn: string;
  price: number | null;
  currency: string;
  /** Shopify product handle — the storefront builds `/products/{handle}` (locale-aware). */
  handle: string;
  /** Clean cdn.shopify.com hero image, or null. */
  imageUrl: string | null;
  /** Customer UGC unboxing video URL (aosom CDN, browser-servable). */
  videoUrl: string;
}

/** Resolve the curated EN title from the `custom.title_en` metafield; FR fallback. */
async function resolveTitleEn(shopifyProductId: string, fallback: string): Promise<string> {
  try {
    const res = await shopifyFetch(
      `/products/${encodeURIComponent(shopifyProductId)}/metafields.json?namespace=custom`,
    );
    if (!res.ok) return fallback;
    const data = (await res.json()) as { metafields?: Array<{ key: string; value: string }> };
    const value = (data.metafields ?? []).find((m) => m.key === "title_en")?.value?.trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build the reel: up to `count` enriched items, most-in-stock first. Each product
 * is verified live on Shopify — only `status: "active"` products are kept, and the
 * PDP handle + price come from the live Shopify record (authoritative), not Turso.
 * Products that aren't active, or whose curated FR title can't be resolved (we never
 * show the raw English catalog name), are skipped, so extra candidates are pulled as
 * headroom to still reach `count` when some drop out.
 */
export async function getUgcVideoReel(count = 15): Promise<UgcReelItem[]> {
  const candidates = await getUgcVideoCandidates(count + 8);
  const items: UgcReelItem[] = [];
  for (const c of candidates) {
    if (items.length >= count) break;
    if (!c.shopifyProductId) continue;
    const fields = await resolveProductFields(c.shopifyProductId);
    // Only surface products that are live (active) on Shopify.
    if (fields.status !== "active") continue;
    const titleFr = fields.titleFr?.trim();
    if (!titleFr) continue;
    // Authoritative PDP handle from Shopify; Turso handle only as a fallback.
    const handle = fields.handle || c.shopifyHandle;
    if (!handle) continue;
    const titleEn = await resolveTitleEn(c.shopifyProductId, titleFr);
    const shopifyPrice = fields.price == null ? null : Number(fields.price);
    items.push({
      sku: c.sku,
      titleFr,
      titleEn,
      // Live Shopify variant price; Turso price only as a last-resort fallback.
      price: shopifyPrice != null && Number.isFinite(shopifyPrice) ? shopifyPrice : c.price,
      currency: "CAD",
      handle,
      imageUrl: fields.images[0] ?? null,
      videoUrl: c.videoUgc,
    });
  }
  return items;
}
