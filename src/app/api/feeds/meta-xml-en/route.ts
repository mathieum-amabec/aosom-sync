import { getFeedItems } from "@/lib/feeds/source";
import { buildMetaXmlFeed } from "@/lib/feeds/feed";
import { EN_STOREFRONT_BASE_URL } from "@/lib/insights";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts via the "/api/feeds" prefix) — Meta Commerce ingests RSS/ATOM XML.
// English Meta catalog feed for the SEPARATE "Furnish Direct" catalog (own catalog, own ads, own page):
// titles from custom.title_en (falling back to the FR title), brand "Furnish Direct", links at the root of
// furnishdirect.ca. Same SKUs (retailer_id) as the FR catalog, so the shared pixel's content_ids match both.
// The FR feed (/api/feeds/meta-xml) keeps feeding the Ameublo Direct catalog.
const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=600"; // CDN-cached 10 min — on-demand refresh via POST /api/revalidate

export async function GET() {
  try {
    const items = await getFeedItems({ english: true });
    const xml = buildMetaXmlFeed(items, {
      title: "Furnish Direct — Meta Catalog feed (EN)",
      link: EN_STOREFRONT_BASE_URL,
      description: "Furnish Direct catalog (furniture, outdoor, pets).",
    });
    await recordFeedSync("meta_xml_en", items.length, "success");
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] meta-xml-en failed:", err);
    await recordFeedSync("meta_xml_en", null, "error", err instanceof Error ? err.message : String(err));
    return new Response("Feed temporarily unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
