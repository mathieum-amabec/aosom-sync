import { getFeedItems } from "@/lib/feeds/source";
import { buildPinterestFeed } from "@/lib/feeds/feed";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts) — Pinterest catalog crawler fetches this with no session.
const CACHE = "public, max-age=0, s-maxage=86400, stale-while-revalidate=43200"; // CDN-cached 24h

export async function GET() {
  try {
    const items = await getFeedItems();
    const xml = buildPinterestFeed(items, {
      title: "Ameublo Direct — Pinterest catalog feed",
      link: STOREFRONT_BASE_URL,
      description: "Catalogue Ameublo Direct (meubles, extérieur, animaux).",
    });
    await recordFeedSync("pinterest", items.length, "success");
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] pinterest failed:", err);
    await recordFeedSync("pinterest", null, "error", err instanceof Error ? err.message : String(err));
    return new Response("Feed temporarily unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
