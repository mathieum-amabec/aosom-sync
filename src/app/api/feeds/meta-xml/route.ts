import { getFeedItems } from "@/lib/feeds/source";
import { buildMetaXmlFeed } from "@/lib/feeds/feed";
import { STOREFRONT_BASE_URL } from "@/lib/insights";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts) — Meta Commerce ingests RSS/ATOM XML (not JSON).
// Same RSS 2.0 + g: shape as the Google feed, plus g:custom_label_0 + g:sale_price.
const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=600"; // CDN-cached 10 min — on-demand refresh via POST /api/revalidate

export async function GET() {
  try {
    const items = await getFeedItems();
    const xml = buildMetaXmlFeed(items, {
      title: "Ameublo Direct — Meta Catalog feed",
      link: STOREFRONT_BASE_URL,
      description: "Catalogue Ameublo Direct (meubles, extérieur, animaux).",
    });
    await recordFeedSync("meta_xml", items.length, "success");
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] meta-xml failed:", err);
    await recordFeedSync("meta_xml", null, "error", err instanceof Error ? err.message : String(err));
    return new Response("Feed temporarily unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
