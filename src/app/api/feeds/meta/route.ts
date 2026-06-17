import { getFeedItems } from "@/lib/feeds/source";
import { buildMetaFeed } from "@/lib/feeds/feed";
import { recordFeedSync } from "@/lib/database";

// Public (allowlisted in proxy.ts) — Meta Commerce catalog data feed (JSON), no session.
const CACHE = "public, max-age=0, s-maxage=600, stale-while-revalidate=600"; // CDN-cached 10 min — on-demand refresh via POST /api/revalidate

export async function GET() {
  try {
    const items = await getFeedItems();
    const json = buildMetaFeed(items);
    await recordFeedSync("meta", items.length, "success");
    return new Response(JSON.stringify(json), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": CACHE },
    });
  } catch (err) {
    console.error("[FEED] meta failed:", err);
    await recordFeedSync("meta", null, "error", err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ error: "Feed temporarily unavailable" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
