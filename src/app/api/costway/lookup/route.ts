import { NextResponse } from "next/server";
import { lookupVariant } from "@/lib/costway/db";

/**
 * GET /api/costway/lookup?q=<internal SKU | Costway SKU | item no>
 *
 * Turns the opaque SKU printed on a Shopify order (e.g. "M7ZGG3GC") into what has to be ordered by
 * hand at costway.ca: the supplier SKU, the colour, the product link, our cost, the margin and the
 * current stock (Canadian stock first). Exact matches only; an unknown SKU answers `data: []`.
 *
 * The supplier SKU is returned here ON PURPOSE — this is the internal admin tool. It must never be
 * copied into anything that ships to Shopify. Session-protected by src/proxy.ts like every
 * non-public route.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json({ success: false, error: "Paramètre q requis (SKU de la commande)" }, { status: 400 });
  }
  if (q.length > 80) {
    return NextResponse.json({ success: false, error: "SKU trop long" }, { status: 400 });
  }
  try {
    const hits = await lookupVariant(q);
    return NextResponse.json({ success: true, data: hits });
  } catch (err) {
    console.error(`[API] /api/costway/lookup failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
