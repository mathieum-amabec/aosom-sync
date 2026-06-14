import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { runPriceAudit, persistPriceAudit } from "@/lib/price-audit";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * GET /api/health/price-audit — compares the live Shopify price of every variant against
 * `products.price` (the Aosom feed price = the FLOOR), and reports variants priced below it.
 *
 * Protected by CRON_SECRET (Bearer). Returns { total, below_floor, items:[{sku, shopify_price,
 * aosom_price, gap}] } where gap = shopify_price - aosom_price (negative = below floor). Also
 * persists a compact summary to settings so the dashboard "Alertes" panel can flag below_floor>0
 * without re-running the (expensive) full Shopify fetch on every load.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runPriceAudit();
    await persistPriceAudit(result, Math.floor(Date.now() / 1000));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[API] GET /api/health/price-audit failed:", err);
    return NextResponse.json({ error: "Price audit failed" }, { status: 500 });
  }
}
