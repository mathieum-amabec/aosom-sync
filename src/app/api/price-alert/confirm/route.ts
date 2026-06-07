/**
 * GET /api/price-alert/confirm?token=XXX — double opt-in confirmation link.
 *
 * Clicked from the confirmation email. On a valid, non-expired token: marks the
 * alert confirmed, clears the token (single use), and redirects to the product
 * page with ?price_alert=confirmed. On an unknown/expired/used token: a small
 * bilingual error page (no redirect, so the user sees why).
 *
 * Public (allow-listed under /api/price-alert in proxy.ts).
 */
import { NextResponse } from "next/server";
import { confirmPriceAlert } from "@/lib/database";

export const runtime = "nodejs";

const STOREFRONT_BASE = "https://ameublodirect.ca";

function errorPage(): NextResponse {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lien expiré / Link expired</title>
<style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A2340;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:24px}
.card{max-width:420px;text-align:center;background:#fff;border:1px solid #ece6dd;border-radius:10px;padding:28px}
a{color:#C17F3E;font-weight:600}</style></head>
<body><div class="card">
<h1 style="font-size:20px;margin:0 0 12px">🔔 Lien invalide ou expiré</h1>
<p>Ce lien de confirmation est invalide ou a expiré (24h). Réinscris-toi depuis la page du produit.</p>
<hr style="border:none;border-top:1px solid #ece6dd;margin:18px 0">
<p style="color:#797068"><strong>Invalid or expired link.</strong> This confirmation link is invalid or has expired (24h). Please sign up again from the product page.</p>
<p><a href="${STOREFRONT_BASE}">${"←"} Ameublo Direct</a></p>
</div></body></html>`;
  return new NextResponse(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return errorPage();

  const confirmed = await confirmPriceAlert(token);
  if (!confirmed) return errorPage();

  const target = confirmed.shopifyHandle
    ? `${STOREFRONT_BASE}/products/${confirmed.shopifyHandle}?price_alert=confirmed`
    : `${STOREFRONT_BASE}?price_alert=confirmed`;
  return NextResponse.redirect(target, 302);
}
