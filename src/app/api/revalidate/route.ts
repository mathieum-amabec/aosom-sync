import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { revalidateFeeds } from "@/lib/feeds/revalidate";

/**
 * POST /api/revalidate — Bearer CRON_SECRET.
 *
 * On-demand refresh of the storefront product feeds. Busts the shared Shopify Data
 * Cache (tag 'feeds') and revalidates each feed route, so the next CDN re-pull serves
 * fresh data. Intended to be called right after a catalog sync so the feeds reflect
 * new/removed/republished products without waiting out the cache.
 *
 * Propagation note: revalidateTag/revalidatePath invalidate Next's server-side caches.
 * The Vercel CDN keeps serving its cached response until the routes' `s-maxage` (10 min)
 * expires — that bounded window is the max delay before the live feed updates, not a
 * separate purge step. (Instant CDN purge would require `force-static`, which would crawl
 * Shopify at build time and make deploys fragile — deliberately avoided.)
 */
export async function POST(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ revalidated: false, error: "Unauthorized" }, { status: 401 });
  }

  // Shared 'feeds' data tag + per-route invalidation (see lib/feeds/revalidate.ts).
  const feeds = revalidateFeeds();
  return NextResponse.json({ revalidated: true, feeds: [...feeds] });
}
