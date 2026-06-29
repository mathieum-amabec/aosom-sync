import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { revalidateTag, revalidatePath } from "next/cache";

// Every storefront feed (Google / Pinterest / Meta, incl. the EN + XML variants) derives
// from one shared Shopify product fetch tagged 'feeds' in lib/feeds/source.ts. Refreshing
// the feeds = bust that Data Cache tag + revalidate each feed route's path. The route
// names double as the URL segment under /api/feeds/.
const FEEDS = ["google", "pinterest", "pinterest-en", "meta", "meta-xml", "bing", "reddit"] as const;



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

  // One shared data tag → refreshes the product data behind every feed.
  revalidateTag("feeds", "max");
  // Per-route invalidation so each feed route regenerates on its next request.
  for (const feed of FEEDS) revalidatePath(`/api/feeds/${feed}`);

  return NextResponse.json({ revalidated: true, feeds: [...FEEDS] });
}
