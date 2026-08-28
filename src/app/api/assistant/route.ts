import { runAssistant, runComplementary, type AssistantTurn, type Locale } from "@/lib/assistant";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  countAssistantRequests,
  recordAssistantRequest,
  secondsUntilAssistantSlot,
} from "@/lib/database";
import {
  MAX_MESSAGES_PER_HOUR,
  RATE_WINDOW_SECS,
  isRapidFire,
  limitPayload,
} from "@/lib/assistant-limits";
import { ASSISTANT_TOKEN_HEADER, verifyAssistantToken } from "@/lib/assistant-auth";
import { LlmBudgetExceededError } from "@/lib/llm-budget";

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
    // X-Assistant-Token MUST be listed: a custom header makes the POST non-simple, so the
    // browser sends a preflight first and drops the real request if the header is not
    // allowed here. Omitting it breaks the widget in a way that never reaches our logs.
    "Access-Control-Allow-Headers": "Content-Type, X-Assistant-Token",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (isAllowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

/**
 * Strip markup and control characters out of shopper text before it reaches Claude.
 *
 * This is defence-in-depth, not a prompt-injection fix: the system prompt is a pure function
 * of `locale`, so shopper text never reaches it, and text in the user-message position is not
 * injection. What this actually buys us is the echo path — the model can repeat back what the
 * shopper typed, and the storefront widget renders that reply. If the widget ever uses
 * innerHTML instead of textContent, `<img onerror=…>` in the shopper's own message becomes
 * stored-XSS-by-proxy. Cutting the markup here closes that path from the server side, which
 * we control, rather than relying on a theme snippet that lives outside this repo.
 */
export function sanitizeShopperText(input: string): string {
  const noMarkup = String(input ?? "")
    .replace(/<[^>]*>/g, " ") // any tag, opening or closing
    .replace(/[<>]/g, " "); // stray angle brackets (unbalanced markup)
  // Drop control characters by code point rather than by regex escape: the intent stays
  // readable and there is no escape sequence to mangle. Tab and newline are kept.
  const printable = Array.from(noMarkup)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c === 9 || c === 10 || (c >= 32 && c !== 127);
    })
    .join("");
  return printable.replace(/\s{2,}/g, " ").trim();
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

  // Shared-secret gate on top of the Origin check. Origin is a header any non-browser
  // client sets freely, so on its own it stops nobody who is trying; the token means a
  // caller has to know something rather than merely claim it. See lib/assistant-auth.ts for
  // why this is a doorman and not a vault — the widget is public theme source.
  //
  // `not_configured` (no ASSISTANT_SECRET set) deliberately passes: the deployed widget
  // sends no custom header yet, and failing closed here would take the storefront assistant
  // down the moment this deploys. Set the env var only AFTER the theme snippet is updated.
  const verdict = verifyAssistantToken(request.headers.get(ASSISTANT_TOKEN_HEADER));
  if (verdict === "missing" || verdict === "invalid") {
    return json({ success: false, error: "forbidden_token" }, 403);
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

    const message = sanitizeShopperText(typeof body.message === "string" ? body.message : "");
    if (!message) return json({ success: false, error: "message_required" }, 400);
    if (message.length > 1000) return json({ success: false, error: "message_too_long" }, 400);

    const history: AssistantTurn[] = Array.isArray(body.history)
      ? (body.history as unknown[])
          .filter((t): t is { role: string; content: string } => !!t && typeof (t as { content?: unknown }).content === "string")
          .filter((t) => t.role === "user" || t.role === "assistant")
          .slice(-8)
          .map((t) => ({ role: t.role as "user" | "assistant", content: sanitizeShopperText(t.content) }))
          .filter((t) => t.content)
      : [];

    // Rapid-fire guard — three shopper turns with no assistant turn between them. Checked
    // before the quota so a shopper spamming the widget gets the hand-off immediately
    // instead of burning through their hourly allowance first.
    if (isRapidFire(history)) {
      return json({ success: true, data: limitPayload(locale, "consecutive_messages", 60) }, 200);
    }

    // Hourly per-IP quota (Turso sliding window). Doubles as the session cap — see
    // src/lib/assistant-limits.ts. Fails OPEN on a DB error: the storefront assistant must
    // not go dark because the counter is unreachable, and the in-memory limiter above plus
    // the assistant token pool still bound the damage.
    const ip = clientIp(request);
    let used = 0;
    try {
      used = await countAssistantRequests(ip, RATE_WINDOW_SECS);
    } catch (err) {
      console.warn("[assistant] quota read failed — allowing:", err instanceof Error ? err.message : err);
      used = -1;
    }
    if (used >= MAX_MESSAGES_PER_HOUR) {
      // Tell the shopper WHEN, not just no: seconds until this IP's oldest in-window
      // request ages out. Best-effort — a read failure falls back to the full window.
      let retryAfter = RATE_WINDOW_SECS;
      try {
        retryAfter = await secondsUntilAssistantSlot(ip, RATE_WINDOW_SECS);
      } catch { /* fall back to the full window */ }

      // 429 is the honest status for machines (monitoring, any future API client), but the
      // body still carries `success: true` and `data.reply`. That is not sloppiness: the
      // DEPLOYED widget does `fetch(...).then(r => r.json())` with NO status check, and
      // renders `data.reply` only when `j.success && j.data`. With `success: false` the
      // shopper would get the generic "Désolé, une erreur est survenue" instead of being
      // told to come back in twelve minutes. Status for machines, body for humans.
      return json(
        { success: true, data: limitPayload(locale, "hourly_quota", retryAfter) },
        429,
      );
    }

    const result = await runAssistant({ message, history, locale });

    // Recorded only after a SUCCESSFUL answer, so a failed generation doesn't consume the
    // shopper's allowance. Best-effort: a bookkeeping failure must not fail the reply.
    if (used >= 0) {
      try {
        await recordAssistantRequest(ip);
      } catch { /* quota bookkeeping is best-effort */ }
    }

    return json({ success: true, data: result });
  } catch (err) {
    // Daily assistant token pool exhausted. This used to fall through to the 500 below, and
    // the widget then showed "Désolé, une erreur est survenue" — telling the shopper the
    // assistant was broken when it was simply rationed for the day. The pool has been
    // reaching its cap on most days, so this is a common path, not a corner case.
    //
    // Caught out here rather than around runAssistant so the PDP "Complétez la pièce" mode
    // (runComplementary, same pool, earlier in this try) gets the same graceful hand-off
    // instead of a 500. `locale` is parsed before the try precisely so it is readable here.
    if (err instanceof LlmBudgetExceededError) {
      console.warn("[assistant] daily pool exhausted — serving the hand-off card:", err.message);
      return json({ success: true, data: limitPayload(locale, "budget_exhausted", 0) }, 503);
    }
    console.error("[API] /api/assistant failed:", err);
    return json({ success: false, error: "assistant_failed" }, 500);
  }
}

export const maxDuration = 60;
