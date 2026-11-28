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
import { dispatchEvent } from "@/lib/email/dispatch";
import { getShopifyProductTitle } from "@/lib/shopify-client";

export const maxDuration = 60;

const STOREFRONT_BASE = "https://ameublodirect.ca";

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const alerts = await getTriggeredPriceAlerts();
  const notifiedIds: number[] = [];
  let failed = 0;
  // products.name is the raw ENGLISH supplier title: the email shows the French storefront title (one read per product)
  const titles = new Map<string, string>();
  const titleOf = async (id: string | null) => {
    if (!id) return "";
    if (!titles.has(id)) titles.set(id, await getShopifyProductTitle(id, ""));
    return titles.get(id)!;
  };

  for (const alert of alerts) {
    const productUrl = alert.shopifyHandle
      ? `${STOREFRONT_BASE}/products/${alert.shopifyHandle}`
      : STOREFRONT_BASE;
    // Klaviyo event, or the email itself through Resend (settings email_provider, src/lib/email/dispatch.ts)
    const res = await dispatchEvent("Price Drop Alert", alert.email, {
      sku: alert.sku,
      product_name: await titleOf(alert.shopifyProductId ?? null),
      old_price: alert.priceAtSignup,
      new_price: alert.currentPrice,
      product_url: productUrl,
    }, { idemKey: `baisse-prix-alerte:${alert.id}:${alert.currentPrice}` });
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
