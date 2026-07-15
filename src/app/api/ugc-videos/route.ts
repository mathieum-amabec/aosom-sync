/**
 * GET /api/ugc-videos — public storefront endpoint for the homepage
 * "Voyez-le chez vous" UGC video reel (theme snippet `lc_ugc_video_reel.liquid`).
 *
 * Called cross-origin from the Shopify storefront, so it answers CORS preflight
 * and echoes an allow-listed Origin. Public (allow-listed in `proxy.ts`). Returns
 * up to 15 most-in-stock products that have a clean CA/US customer unboxing video
 * AND are live (`status: "active"`) on Shopify, each with curated FR + EN titles,
 * live Shopify price, authoritative PDP handle, a clean cdn.shopify.com image, and
 * the video URL. Response is edge-cached (`s-maxage`) so Shopify is hit at most
 * ~once per 30 min, not on every homepage load.
 */
import { NextResponse } from "next/server";
import { getUgcVideoReel } from "@/lib/ugc-reel";

export const runtime = "nodejs";

// Storefront origins allowed to read this (mirrors /api/price-alert).
const ALLOWED_ORIGINS = new Set([
  "https://ameublodirect.ca",
  "https://www.ameublodirect.ca",
  "https://furnishdirect.ca",
  "https://www.furnishdirect.ca",
  "https://ameublodirect.myshopify.com",
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
  try {
    const items = await getUgcVideoReel(15);
    return NextResponse.json(
      { items, count: items.length },
      {
        status: 200,
        headers: {
          ...cors,
          "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      { items: [], count: 0, error: String(err) },
      { status: 500, headers: cors },
    );
  }
}
