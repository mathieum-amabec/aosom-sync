/**
 * POST /api/waitlist — "notify me when back in stock" signup.
 *
 * Called cross-origin from the Shopify storefront, so it answers CORS preflight
 * and echoes an allow-listed Origin. Public (allow-listed in proxy.ts) but
 * locked down: per-IP rate limit, a 1-per-(email,sku)-per-hour anti-spam limit,
 * email + sku validation, and the SKU must exist in the catalog.
 *
 * Double opt-in (CASL): the signup is stored unconfirmed and a confirmation email
 * is sent ("Back In Stock Confirmation" Klaviyo event with a confirm link). Only
 * after the recipient clicks the link (→ /api/waitlist/confirm) does the row become
 * confirmed; the actual "Back In Stock" restock email (Job 1) only ever goes to
 * confirmed rows. This prevents emailing an address someone else typed in.
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { getProduct, upsertWaitlistEntry } from "@/lib/database";
import { identifyProfile, trackEvent } from "@/lib/klaviyo-client";
import { checkRateLimit } from "@/lib/rate-limiter";
import { storeLink } from "@/lib/insights";
import { getPublicAppUrl } from "@/lib/config";

export const runtime = "nodejs";

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // confirmation link valid 24h
const PUBLIC_BASE_FALLBACK = "https://aosom-sync.vercel.app";

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

  // Coarse per-IP guard against enumeration / floods.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(`waitlist-ip:${ip}`, 20, 60_000).allowed) {
    return json(429, { success: false, error: "Too Many Requests" });
  }

  let body: { email?: unknown; sku?: unknown; shopify_product_id?: unknown };
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

  const email = body.email.trim().toLowerCase();
  const sku = body.sku.trim();

  // Anti-spam: at most 1 signup per (email, sku) per hour.
  if (!checkRateLimit(`waitlist:${email}:${sku}`, 1, 60 * 60_000).allowed) {
    return json(429, { success: false, error: "Already requested — try again later." });
  }

  const product = await getProduct(sku);
  if (!product) {
    return json(404, { success: false, error: "Unknown product" });
  }

  // Prefer the server-side Shopify identity over any client-sent id.
  const shopifyProductId =
    (product.shopify_product_id as string) ||
    (typeof body.shopify_product_id === "string" ? body.shopify_product_id.trim() : "") ||
    null;

  const confirmToken = crypto.randomUUID();
  const tokenExpiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

  await upsertWaitlistEntry({ email, sku, shopifyProductId, confirmToken, tokenExpiresAt });

  // Double opt-in: the row stays confirmed=0 (the restock job skips it) until the
  // recipient clicks the emailed link, so restock alerts never go to an address
  // that didn't opt in. Send the confirmation email via Klaviyo.
  const base = getPublicAppUrl() || PUBLIC_BASE_FALLBACK;
  const confirmUrl = `${base}/api/waitlist/confirm?token=${encodeURIComponent(confirmToken)}`;
  const productUrl = storeLink(shopifyProductId, (product.shopify_handle as string) || null).shopifyUrl;
  try {
    await identifyProfile(email, { last_back_in_stock_sku: sku });
    const tracked = await trackEvent("Back In Stock Confirmation", email, {
      confirm_url: confirmUrl,
      sku,
      product_name: (product.name as string) || sku,
      product_url: productUrl,
    });
    if (!tracked.ok) {
      console.warn(`[waitlist] confirmation email not sent for ${email}: ${tracked.skipped ? "Klaviyo not configured" : tracked.error}`);
    }
  } catch (err) {
    console.warn(`[waitlist] Klaviyo confirmation failed for ${email}: ${err}`);
  }

  return json(200, { success: true, message: "Vérifiez votre courriel pour confirmer / Check your email to confirm." });
}
