import { NextResponse } from "next/server";
import { getCatalogStats } from "@/lib/database";

/**
 * GET /api/catalog/stats — header metrics for the catalog page:
 * total products, how many are imported into Shopify, how many have an active
 * rabais, and the most recent sync cron run. Cheap (a few COUNT(*)s); the page
 * fetches it once on mount, independent of the filtered/paginated listing.
 */
export async function GET() {
  try {
    const stats = await getCatalogStats();
    // These counts only change on sync. The "Avec rabais" count in particular is a
    // correlated subquery over price_history (one pass per product) — very expensive
    // in Turso row-reads. CDN-cache it for 10 min so it runs ~once/10min instead of
    // on every catalog page mount (~144× fewer reads/day on this route). Stats are
    // global (identical for all users), so `public` caching is safe.
    return NextResponse.json(
      { success: true, data: stats },
      { headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=60" } },
    );
  } catch (err) {
    console.error("[API] /api/catalog/stats failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
