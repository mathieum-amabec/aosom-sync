import { getFeedItems } from "@/lib/feeds/source";
import { buildMetaFeed } from "@/lib/feeds/feed";

// Public (allowlisted in proxy.ts) — Meta Commerce catalog data feed (JSON), no session.
const CACHE = "public, max-age=0, s-maxage=86400, stale-while-revalidate=43200"; // CDN-cached 24h

export async function GET() {
  try {
    const items = await getFeedItems();
    const json = buildMetaFeed(items);
    return new Response(JSON.stringify(json), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] meta failed:", err);
    return new Response(JSON.stringify({ error: "Feed temporarily unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
