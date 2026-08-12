import { getFeedItems } from "@/lib/feeds/source";
import { buildPinterestFeed } from "@/lib/feeds/feed";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts via the "/api/feeds" prefix) — Pinterest's catalog
// crawler fetches this with no session.
// English variant of /api/feeds/pinterest: titles come from custom.title_en (falling back to
// the FR title), links point at the `/en` storefront and the brand is "Furnish Direct" — the
// store's EN identity. Channel metadata below matches, so the feed does not announce itself
// as Ameublo Direct while every offer inside it links to a Furnish Direct page.
const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=600"; // CDN-cached 10 min — on-demand refresh via POST /api/revalidate

export async function GET() {
  try {
    const items = await getFeedItems({ english: true });
    const xml = buildPinterestFeed(items, {
      title: "Furnish Direct — Pinterest catalog feed (EN)",
      link: `${STOREFRONT_BASE_URL}/en`,
      description: "Furnish Direct catalog (furniture, outdoor, pets).",
    });
    await recordFeedSync("pinterest_en", items.length, "success");
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] pinterest-en failed:", err);
    await recordFeedSync("pinterest_en", null, "error", err instanceof Error ? err.message : String(err));
    return new Response("Feed temporarily unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
