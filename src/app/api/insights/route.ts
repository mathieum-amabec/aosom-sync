import { NextResponse } from "next/server";
import { getRecentPriceChanges } from "@/lib/database";
import { API } from "@/lib/config";

/**
 * GET /api/insights — Price changes and trends.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || String(API.DEFAULT_INSIGHTS_LIMIT), 10) || API.DEFAULT_INSIGHTS_LIMIT), API.MAX_INSIGHTS_LIMIT);

    const raw = getRecentPriceChanges(limit);
    const changes = raw
      .filter((r) => r.change_type === "price_drop" || r.change_type === "price_increase")
      .map((r) => {
        const oldPrice = Number(r.old_price) || 0;
        const newPrice = Number(r.new_price) || 0;
        const change = newPrice - oldPrice;
        return {
          sku: r.sku as string,
          name: (r.name as string) || r.sku as string,
          image: (r.image1 as string) || "",
          oldPrice,
          newPrice,
          change,
          pct: oldPrice > 0 ? (change / oldPrice) * 100 : 0,
          recordedAt: r.detected_at as string,
        };
      });

    return NextResponse.json({ success: true, data: { changes, sellers: [] } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[API] /api/insights failed: ${message}`);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
