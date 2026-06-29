/**
 * GET /api/price-alert/notify — daily cron.
 *
 * Finds pending price alerts whose product price has dropped below the signup
 * price, fires a "Price Drop Alert" Klaviyo event per subscriber (which drives
 * the email flow), and stamps notified_at so they aren't re-notified. Protected
 * by CRON_SECRET (constant-time check), matching the other cron routes.
 */
import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { getTriggeredPriceAlerts, markPriceAlertsNotified } from "@/lib/database";
import { trackEvent } from "@/lib/klaviyo-client";

export const maxDuration = 60;

const STOREFRONT_BASE = "https://ameublodirect.ca";

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const alerts = await getTriggeredPriceAlerts();
  const notifiedIds: number[] = [];
  let failed = 0;

  for (const alert of alerts) {
    const productUrl = alert.shopifyHandle
      ? `${STOREFRONT_BASE}/products/${alert.shopifyHandle}`
      : STOREFRONT_BASE;
    const res = await trackEvent("Price Drop Alert", alert.email, {
      sku: alert.sku,
      product_name: alert.productName,
      old_price: alert.priceAtSignup,
      new_price: alert.currentPrice,
      product_url: productUrl,
    });
    // Only mark notified when the event was actually accepted by Klaviyo. If the
    // key is unset (skipped) or the call errored, leave the alert pending so the
    // next run retries — we never want to silently swallow an un-sent alert.
    if (res.ok) {
      notifiedIds.push(alert.id);
    } else {
      failed++;
    }
  }

  await markPriceAlertsNotified(notifiedIds);

  return NextResponse.json({
    success: true,
    triggered: alerts.length,
    notified: notifiedIds.length,
    failed,
  });
}
