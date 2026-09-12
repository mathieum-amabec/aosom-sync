/**
 * GET /api/trending — public storefront endpoint for the landing page's two
 * trend-driven sections: the "Les plus demandés cette semaine" product carousel
 * and the popular-subcategory tile grid. Read by the theme sections
 * `lc_trending_products` and `lc_trending_subcats`.
 *
 * Called cross-origin from the Shopify storefront, so it answers CORS preflight
 * and echoes an allow-listed Origin. Public (allow-listed in `proxy.ts`).
 * Rankings come from `trend_scores` (recomputed weekly by
 * /api/cron/trend-scores); product prices are resolved live from Shopify on each
 * miss, so the response is edge-cached (`s-maxage`) exactly like /api/ugc-videos.
 */
import { NextResponse } from "next/server";
import { getTrendingSections, PRODUCT_CARD_COUNT } from "@/lib/trending-sections";

export const runtime = "nodejs";

// Storefront origins allowed to read this (mirrors /api/ugc-videos).
const ALLOWED_ORIGINS = new Set([
  "https://ameublodirect.ca",
  "https://www.ameublodirect.ca",
  "https://furnishdirect.ca",
  "https://www.furnishdirect.ca",
  "https://ameublodirect.myshopify.com",
  "https://27u5y2-kp.myshopify.com",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function GET(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 24) : PRODUCT_CARD_COUNT;

  try {
    const sections = await getTrendingSections(limit);
    return NextResponse.json(
      { ...sections, productCount: sections.products.length, tileCount: sections.subcategories.length },
      {
        status: 200,
        headers: {
          ...cors,
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      },
    );
  } catch (err) {
    console.error("[API] GET /api/trending failed:", err);
    return NextResponse.json(
      { products: [], subcategories: [], computedAt: null, productCount: 0, tileCount: 0, error: String(err) },
      { status: 500, headers: cors },
    );
  }
}
