import { runAssistant, runComplementary, type AssistantTurn, type Locale } from "@/lib/assistant";
import { checkRateLimit } from "@/lib/rate-limiter";

/**
 * POST /api/assistant — PUBLIC storefront shopping assistant. No auth (called from the
 * storefront), so it is hardened: CORS allowlist, per-IP rate limit, strict input caps,
 * and a bounded Claude tool-use loop (see src/lib/assistant.ts).
 *
 * Body (chat):          { message: string, history?: {role,content}[], locale?: "fr"|"en" }
 * Body (PDP complement): { mode: "complementary", name: string, productType: string, locale?: "fr"|"en" }
 */

// Storefront origins allowed to call this endpoint cross-origin. Scoped to OUR storefronts
// only (both custom domains + our Shopify preview host) so another store can't point its
// theme at our paid endpoint.
const ALLOWED_ORIGIN = [
  /^https:\/\/(www\.)?ameublodirect\.ca$/,
  /^https:\/\/(www\.)?furnishdirect\.ca$/,
  /^https:\/\/27u5y2-kp\.myshopify\.com$/, // our theme preview host
];

function isAllowedOrigin(origin: string | null): origin is string {
  return !!origin && ALLOWED_ORIGIN.some((re) => re.test(origin));
}

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (isAllowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/**
 * Best-effort client IP for rate-limiting. Prefer `x-real-ip` (set by Vercel to the real
 * client IP); otherwise take the LAST `x-forwarded-for` hop (Vercel appends the true client
 * IP at the end — the FIRST entry is attacker-supplied and must never be trusted).
 */
function clientIp(request: Request): string {
  const real = request.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return "unknown";
}

export function OPTIONS(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get("origin")) });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });

  // Server-side origin gate. CORS response headers are advisory (browser-enforced only) and
  // do NOT stop a direct caller; this rejects any request whose Origin isn't one of our
  // storefronts. Browsers always send Origin on the cross-origin POST the widget makes, so
  // legitimate traffic is unaffected while curl-without-Origin is blocked outright.
  if (!isAllowedOrigin(origin)) {
    return json({ success: false, error: "forbidden_origin" }, 403);
  }

  // Global cost backstop — caps total spend across ALL callers (defends against distributed
  // / IP-rotating abuse that a per-IP limit can't). In-memory per instance, so it's a floor,
  // not a ceiling; a platform WAF / spend alert should back it in production.
  if (!checkRateLimit("assistant:global", 90, 60_000).allowed) {
    return json({ success: false, error: "busy", retryAfter: 30 }, 429);
  }

  // Per-IP rate limit — public endpoint that spends Claude credits. 12 req / 60s.
  const { allowed, retryAfterMs } = checkRateLimit(`assistant:${clientIp(request)}`, 12, 60_000);
  if (!allowed) {
    return json({ success: false, error: "rate_limited", retryAfter: Math.ceil(retryAfterMs / 1000) }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ success: false, error: "invalid_json" }, 400);
  }

  const locale: Locale = body.locale === "en" ? "en" : "fr";

  try {
    if (body.mode === "complementary") {
      const name = typeof body.name === "string" ? body.name : "";
      const productType = typeof body.productType === "string" ? body.productType : "";
      if (!name || !productType) return json({ success: false, error: "name_and_productType_required" }, 400);
      const result = await runComplementary({ name, productType, locale });
      return json({ success: true, data: result });
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return json({ success: false, error: "message_required" }, 400);
    if (message.length > 1000) return json({ success: false, error: "message_too_long" }, 400);

    const history: AssistantTurn[] = Array.isArray(body.history)
      ? (body.history as unknown[])
          .filter((t): t is { role: string; content: string } => !!t && typeof (t as { content?: unknown }).content === "string")
          .filter((t) => t.role === "user" || t.role === "assistant")
          .slice(-8)
          .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }))
      : [];

    const result = await runAssistant({ message, history, locale });
    return json({ success: true, data: result });
  } catch (err) {
    console.error("[API] /api/assistant failed:", err);
    return json({ success: false, error: "assistant_failed" }, 500);
  }
}

export const maxDuration = 60;
