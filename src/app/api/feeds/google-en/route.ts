import { getFeedItems } from "@/lib/feeds/source";
import { buildGoogleFeed } from "@/lib/feeds/feed";
import { EN_STOREFRONT_BASE_URL } from "@/lib/insights";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts via the "/api/feeds" prefix) — Google Merchant Center fetches
// this with no session.
// English Google Merchant feed for furnishdirect.ca: titles from custom.title_en (falling back
// to the FR title), links at the root of furnishdirect.ca, brand "Furnish Direct". The FR feed
// (/api/feeds/google) keeps serving ameublodirect.ca. Register this one in Merchant Center as its
// own data source with its own feed label (see docs/FURNISHDIRECT-ADS-SETUP.md): offer ids are the
// same SKUs as the FR feed, so it must NOT share a (feed label, language) pair with it.
const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=600"; // CDN-cached 10 min — on-demand refresh via POST /api/revalidate

export async function GET() {
  try {
    const items = await getFeedItems({ english: true });
    const xml = buildGoogleFeed(items, {
      title: "Furnish Direct — Google Merchant feed (EN)",
      link: EN_STOREFRONT_BASE_URL,
      description: "Furnish Direct catalog (furniture, outdoor, pets).",
    });
    await recordFeedSync("google_en", items.length, "success");
    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] google-en failed:", err);
    await recordFeedSync("google_en", null, "error", err instanceof Error ? err.message : String(err));
    return new Response("Feed temporarily unavailable", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
