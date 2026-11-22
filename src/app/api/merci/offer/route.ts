/**
 * POST /api/merci/offer — offre de remerciement for the thank-you page (checkout UI extension "merci-offre").
 *
 * Auth: `Authorization: Bearer <session token>` from shopify.sessionToken.get() — an HS256 JWT signed with the
 * "Ameublo Merci" app secret (SHOPIFY_MERCI_APP_SECRET, aud = SHOPIFY_MERCI_APP_CLIENT_ID, dest = our store).
 * Body: { orderId, confirmationNumber } (shopify.orderConfirmation.value.order.id / .number). The order is re-read
 * server-side and must belong to the caller: the confirmation number must match, and the token's `sub` (when the
 * buyer is logged in) must be the order's customer — otherwise 403 and the block renders nothing.
 *
 * Responses: 200 { expiresAt, offers[] } (offers empty = render nothing) · 202 { pending } (Shopify has not created
 * the order yet — the extension retries) · 401 token · 403 not the buyer's order · 400 body · 429 rate · 502 code
 * creation · 503 not configured.
 * CORS: extensions run in a Web Worker whose origin can change without notice, so Shopify requires
 * `Access-Control-Allow-Origin: *`; the token is the gate, not the origin. Flow: src/lib/post-purchase/offer-service.ts.
 */
import { NextResponse } from "next/server";
import { env, SHOPIFY } from "@/lib/config";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { verifySessionToken } from "@/lib/post-purchase/session-token";
import { getOrCreateOffer } from "@/lib/post-purchase/offer-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Order read + live re-check + up to 2 code creations: seconds, never minutes. A hung call must not hold the block.
export const maxDuration = 30;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Cache-Control": "no-store",
};

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: CORS });

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  if (!checkRateLimit(`merci:${clientIp(request)}`, 20, 60_000).allowed) return json(429, { error: "rate" });

  const secret = env.merciAppSecret;
  const clientId = env.merciAppClientId;
  if (!secret || !clientId) return json(503, { error: "not-configured" });

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const v = verifySessionToken(token, { secret, clientId, shopDomain: SHOPIFY.STORE });
  if (!v.ok) return json(401, { error: "token" });

  let body: { orderId?: unknown; confirmationNumber?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "json" });
  }
  if (body.orderId == null) return json(400, { error: "orderId" });

  try {
    const out = await getOrCreateOffer(body.orderId, {
      sub: v.claims.sub ?? null,
      confirmationNumber: typeof body.confirmationNumber === "string" ? body.confirmationNumber : null,
    });
    return json(out.status, out.body);
  } catch (err) {
    console.error("[merci] offer failed:", err);
    // The extension renders nothing on any non-200: a failure never shows a broken block to the buyer.
    return json(500, { error: "failed" });
  }
}
