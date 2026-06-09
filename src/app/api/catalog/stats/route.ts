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
    return NextResponse.json({ success: true, data: stats });
  } catch (err) {
    console.error("[API] /api/catalog/stats failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
