import { getFeedItems } from "@/lib/feeds/source";
import { buildBingFeed } from "@/lib/feeds/feed";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts via the "/api/feeds" prefix) — Microsoft Advertising /
// Bing Shopping crawler fetches this with no session. Same shared feed layer as Google;
// Microsoft ingests the Google Shopping RSS+g: format.
const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=600"; // CDN-cached 10 min — on-demand refresh via POST /api/revalidate

export async function GET() {
  try {
    const items = await getFeedItems();
    const xml = buildBingFeed(items, {
      title: "Ameublo Direct — Bing / Microsoft Shopping feed",
      link: STOREFRONT_BASE_URL,
      description: "Catalogue Ameublo Direct (meubles, extérieur, animaux).",
    });
    await recordFeedSync("bing", items.length, "success");
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] bing failed:", err);
    await recordFeedSync("bing", null, "error", err instanceof Error ? err.message : String(err));
    return new Response("Feed temporarily unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
