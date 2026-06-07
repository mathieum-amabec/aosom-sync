/**
 * GET /api/image-preview?sku=XXX&locale=fr&badge=new
 *
 * Returns the branded social image (1080×1080 PNG) composed from a product's
 * primary photo. This is the canonical public URL for the branded image:
 *  - the dashboard uses it to preview a draft's image, and
 *  - the social pipeline injects this URL into a draft's imageUrls so Facebook
 *    and Instagram fetch the branded image directly (they require a hosted URL,
 *    not a buffer/base64).
 *
 * PUBLIC (allow-listed in proxy.ts) so the social platforms can fetch it without
 * a session. Locked down accordingly: composes only for SKUs that exist in the
 * DB, strictly validates locale/badge, and the underlying product image URL
 * still passes the SSRF guard in downloadImage.
 */
import { NextResponse } from "next/server";
import { getProduct } from "@/lib/database";
import { composeProductImage, type Locale, type Badge } from "@/lib/image-compositor";

export const runtime = "nodejs";
export const maxDuration = 60;

const IMAGE_KEYS = ["image1", "image2", "image3", "image4", "image5", "image6", "image7"] as const;

function primaryImage(product: Record<string, unknown>): string | null {
  for (const key of IMAGE_KEYS) {
    const v = product[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function parseLocale(raw: string | null): Locale {
  return raw === "en" ? "en" : "fr";
}

function parseBadge(raw: string | null): Badge | undefined {
  return raw === "new" || raw === "sale" ? raw : undefined;
}

/**
 * Price comes from the URL so it's part of the cache key — the composed PNG is
 * immutable for a given (sku, locale, badge, price) and can be cached safely.
 * Falls back to the live DB price for direct dashboard previews with no param.
 */
function resolvePrice(raw: string | null, dbPrice: number): string {
  if (raw && /^\d{1,7}(\.\d{1,2})?$/.test(raw)) return `${raw} CAD`;
  return `${Number(dbPrice).toFixed(2)} CAD`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sku = searchParams.get("sku");
  if (!sku) {
    return NextResponse.json({ error: "sku required" }, { status: 400 });
  }

  const product = await getProduct(sku);
  if (!product) {
    return NextResponse.json({ error: "Unknown sku" }, { status: 404 });
  }

  const productImageUrl = primaryImage(product as unknown as Record<string, unknown>);
  if (!productImageUrl) {
    return NextResponse.json({ error: "Product has no image" }, { status: 404 });
  }

  const locale = parseLocale(searchParams.get("locale"));
  const badge = parseBadge(searchParams.get("badge"));
  const price = resolvePrice(searchParams.get("price"), Number(product.price));

  try {
    const png = await composeProductImage({ productImageUrl, price, locale, badge });
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        // Deterministic for (sku, locale, badge, price) — all in the URL — so the
        // composed PNG caches safely. Lets FB/IG and the dashboard reuse it.
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    // Composition failed (source image gone, sharp error). Redirect to the raw
    // product image so a publishing platform still gets a usable image instead
    // of a 500 that would fail the whole post.
    console.error(`[API] /api/image-preview compose failed for ${sku}, redirecting to raw image:`, err);
    return NextResponse.redirect(productImageUrl, 302);
  }
}
