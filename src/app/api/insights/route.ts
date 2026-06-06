import { NextResponse } from "next/server";
import { getRecentPriceChanges, getTrendingProducts } from "@/lib/database";
import { API } from "@/lib/config";
import { storeLink } from "@/lib/insights";

/**
 * GET /api/insights — Price changes and trends.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || String(API.DEFAULT_INSIGHTS_LIMIT), 10) || API.DEFAULT_INSIGHTS_LIMIT), API.MAX_INSIGHTS_LIMIT);

    const raw = await getRecentPriceChanges(limit);
    const changes = raw
      .filter((r) => r.change_type === "price_drop" || r.change_type === "price_increase")
      .map((r) => {
        const oldPrice = Number(r.old_price) || 0;
        const newPrice = Number(r.new_price) || 0;
        const change = newPrice - oldPrice;
        const link = storeLink(r.shopify_product_id as string | null);
        return {
          sku: r.sku as string,
          name: (r.name as string) || r.sku as string,
          image: (r.image1 as string) || "",
          oldPrice,
          newPrice,
          change,
          pct: oldPrice > 0 ? (change / oldPrice) * 100 : 0,
          recordedAt: r.detected_at as string,
          inStore: link.inStore,
          shopifyUrl: link.shopifyUrl,
        };
      });

    const trending = (await getTrendingProducts(10)).map((t) => {
      const link = storeLink(t.shopify_product_id);
      return {
        sku: t.sku,
        name: t.name,
        image: t.image1 || "",
        price: t.price,
        currentQty: t.current_qty,
        soldPerDay: +(t.units_moved / 14).toFixed(1),
        daysTracked: 14,
        inStore: link.inStore,
        shopifyUrl: link.shopifyUrl,
      };
    });

    return NextResponse.json({ success: true, data: { changes, trending } });
  } catch (err) {
    console.error(`[API] /api/insights failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
