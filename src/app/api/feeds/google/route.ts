import { getFeedItems } from "@/lib/feeds/source";
import { buildGoogleFeed } from "@/lib/feeds/feed";
import { STOREFRONT_BASE_URL } from "@/lib/insights";

// Public (allowlisted in proxy.ts) — Google Merchant crawler fetches this with no session.
const CACHE = "public, max-age=0, s-maxage=86400, stale-while-revalidate=43200"; // CDN-cached 24h

export async function GET() {
  try {
    const items = await getFeedItems();
    const xml = buildGoogleFeed(items, {
      title: "Ameublo Direct — Google Merchant feed",
      link: STOREFRONT_BASE_URL,
      description: "Catalogue Ameublo Direct (meubles, extérieur, animaux).",
    });
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] google failed:", err);
    return new Response("Feed temporarily unavailable", { status: 500 });
  }
}
