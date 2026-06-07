/**
 * POST /api/price-alert — "notify me when the price drops" signup.
 *
 * Called cross-origin from the Shopify storefront, so it answers CORS preflight
 * and echoes an allow-listed Origin. Public (allow-listed in proxy.ts) but
 * locked down: per-IP rate limit, email + sku validation, and the SKU must
 * exist in the catalog. Best-effort Klaviyo profile identify (never fails the
 * signup). The actual "Price Drop Alert" email is sent later by the notify cron.
 */
import { NextResponse } from "next/server";
import { getProduct, upsertPriceAlert } from "@/lib/database";
import { identifyProfile } from "@/lib/klaviyo-client";
import { checkRateLimit } from "@/lib/rate-limiter";

export const runtime = "nodejs";

// Storefront origins allowed to POST here.
const ALLOWED_ORIGINS = new Set([
  "https://ameublodirect.ca",
  "https://www.ameublodirect.ca",
  "https://furnishdirect.ca",
  "https://www.furnishdirect.ca",
  "https://ameublodirect.myshopify.com",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));
  const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: cors });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(`price-alert:${ip}`, 10, 60_000).allowed) {
    return json(429, { success: false, error: "Too Many Requests" });
  }

  let body: { email?: unknown; sku?: unknown; price?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, { success: false, error: "Invalid JSON body" });
  }

  if (!isValidEmail(body.email)) {
    return json(400, { success: false, error: "Valid email required" });
  }
  if (typeof body.sku !== "string" || !body.sku.trim()) {
    return json(400, { success: false, error: "sku required" });
  }
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) {
    return json(400, { success: false, error: "Valid price required" });
  }

  const email = body.email.trim().toLowerCase();
  const sku = body.sku.trim();

  const product = await getProduct(sku);
  if (!product) {
    return json(404, { success: false, error: "Unknown product" });
  }

  // Use the server-side current price as the baseline, NOT the client-sent
  // `price`. Trusting the client value would let an attacker post an inflated
  // price (with a victim's email) so the next cron fires a spurious "price drop"
  // alert. The body price is validated above only as a sanity check.
  const baselinePrice = Number(product.price);
  if (!Number.isFinite(baselinePrice) || baselinePrice <= 0) {
    return json(409, { success: false, error: "Product price unavailable" });
  }

  await upsertPriceAlert({
    email,
    sku,
    shopifyProductId: (product.shopify_product_id as string) || null,
    priceAtSignup: baselinePrice,
  });

  // Best-effort: create/locate the Klaviyo profile so the later Price Drop Alert
  // event has a profile to attach to. Never fail the signup on Klaviyo errors.
  try {
    await identifyProfile(email, { last_price_alert_sku: sku });
  } catch {
    /* ignore — the cron will identify again when it sends the event */
  }

  return json(200, { success: true });
}
