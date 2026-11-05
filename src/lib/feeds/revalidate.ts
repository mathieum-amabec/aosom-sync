import { revalidatePath, revalidateTag } from "next/cache";

// Every storefront feed (Google / Pinterest / Meta / Bing / Reddit, incl. the EN + XML variants)
// derives from one shared Shopify product fetch tagged 'feeds' in lib/feeds/source.ts. Refreshing
// the feeds = bust that Data Cache tag + revalidate each feed route's path. The names double as
// the URL segment under /api/feeds/ — tests/feeds-revalidate.test.ts checks this list against the
// route directories, so a new feed route cannot be forgotten here.
export const FEEDS = [
  "google",
  "google-en",
  "pinterest",
  "pinterest-en",
  "meta",
  "meta-xml",
  "meta-xml-en",
  "bing",
  "reddit",
] as const;

/**
 * Bust the shared 'feeds' Data Cache tag and revalidate every feed route, so the next request
 * (once the CDN's s-maxage of 10 min runs out) rebuilds the feed from fresh Shopify data.
 * Used by POST /api/revalidate and by the sold-out-hide job after it changes product statuses.
 */
export function revalidateFeeds(): readonly string[] {
  revalidateTag("feeds", "max");
  for (const feed of FEEDS) revalidatePath(`/api/feeds/${feed}`);
  return FEEDS;
}
