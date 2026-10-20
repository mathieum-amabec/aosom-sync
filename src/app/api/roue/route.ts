/**
 * POST /api/roue — Roue de bienvenue spin (storefront, cross-origin).
 *
 * Body: { email, consent: boolean, locale: "fr"|"en", website?: "" (honeypot), skill: { a, b, c, answer } }
 * (skill-testing question a + b × c, required by law before a prize drawn by chance).
 * The server draws the prize, creates a unique single-use Shopify code valid 72 h and fires the Klaviyo event that
 * sends the code + 2 reminders. Marketing consent is OPTIONAL (CASL: consent may not be a condition of playing):
 * only a ticked box subscribes the visitor, and Klaviyo sends the flow emails to subscribed profiles only — without
 * it the visitor keeps the code shown on screen (also auto-applied to the cart). One spin per normalized email.
 * Kill switch: settings `roue_enabled` = "0" → 503; also 503 after ROUE_ENDS_AT. See src/lib/welcome-wheel.ts.
 */
import { NextResponse } from "next/server";
import {
  getSetting,
  getWheelSpin,
  countWheelSpinsForIp,
  reserveWheelSpin,
  setWheelSpinCode,
  releaseWheelSpin,
} from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import {
  WHEEL_PRIZES,
  SPINS_PER_IP_PER_DAY,
  ROUE_ENDS_AT,
  drawPrizeIndex,
  isValidEmail,
  isSkillAnswerCorrect,
  normalizeEmailKey,
  hashIp,
  createWheelDiscount,
  subscribeWheelProfile,
  trackWheelWin,
} from "@/lib/welcome-wheel";

export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set([
  "https://ameublodirect.ca",
  "https://www.ameublodirect.ca",
  "https://27u5y2-kp.myshopify.com",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders(request.headers.get("origin")), "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
}

/** GET /api/roue — is the wheel on? Read by the snippet before it shows anything (edge-cached 2 min). */
async function isOpen(): Promise<boolean> {
  return Date.now() <= ROUE_ENDS_AT && (await getSetting("roue_enabled")) !== "0";
}

export async function GET(request: Request) {
  const enabled = await isOpen();
  return NextResponse.json({ enabled }, { headers: { ...corsHeaders(request.headers.get("origin")), "Cache-Control": "public, s-maxage=120, stale-while-revalidate=600" } });
}

/**
 * Client IP for the limits: `x-real-ip` (set by Vercel), else the LAST x-forwarded-for hop — the first hop is
 * attacker-supplied (same rule as /api/assistant). IPv6 is bucketed by /64, the block one household gets.
 */
export function clientIp(request: Request): string {
  let ip = request.headers.get("x-real-ip")?.trim() || "";
  if (!ip) {
    const hops = (request.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
    ip = hops[hops.length - 1] || "unknown";
  }
  if (ip.includes(":")) ip = ip.split(":").slice(0, 4).join(":") + "::/64";
  return ip;
}

// A reservation older than this without a code is a crashed request. Longer than the worst Shopify call
// (25 s timeout, 3 × 30 s rate-limit waits, 2 attempts).
const STALE_RESERVATION_S = 300;

function result(index: number, code: string | null, expiresAt: number | null, already: boolean) {
  const p = WHEEL_PRIZES[index];
  return {
    success: true,
    already,
    prize: { index, key: p.key, amount: p.amount, minSubtotal: p.minSubtotal, labelFr: p.labelFr, labelEn: p.labelEn },
    code,
    expiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
  };
}

export async function POST(request: Request) {
  const cors = corsHeaders(request.headers.get("origin"));
  const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: cors });

  if (!cors["Access-Control-Allow-Origin"]) return json(403, { success: false, error: "origin" });

  const ip = clientIp(request);
  if (!checkRateLimit(`roue:${ip}`, 6, 60_000).allowed) return json(429, { success: false, error: "rate" });

  if (!(await isOpen())) return json(503, { success: false, error: "off" });

  let body: { email?: unknown; consent?: unknown; locale?: unknown; website?: unknown; skill?: unknown };
  try {
    body = await request.json();
  } catch {
    return json(400, { success: false, error: "json" });
  }
  // Honeypot: a hidden field real visitors never fill. Answer like a failure, create nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") return json(400, { success: false, error: "email" });
  if (!isValidEmail(body.email)) return json(400, { success: false, error: "email" });
  const consent = body.consent === true;
  if (!isSkillAnswerCorrect(body.skill)) return json(400, { success: false, error: "skill" });

  const email = body.email.trim().toLowerCase();
  const emailKey = normalizeEmailKey(email);
  const locale = body.locale === "en" ? "en" : "fr";

  const existing = await getWheelSpin(emailKey);
  if (existing) {
    const idx = WHEEL_PRIZES.findIndex((p) => p.key === existing.prize_key);
    // Already played: never hand the code back (anyone could type someone else's email). It is on their first
    // device and, if they ticked the box, in their inbox.
    if (idx >= 0 && existing.code) return json(200, result(idx, null, existing.expires_at, true));
    // Reserved but no code: a concurrent request is still creating it — or one crashed long ago: free it, draw again.
    if (Date.now() / 1000 - existing.created_at < STALE_RESERVATION_S) return json(409, { success: false, error: "busy" });
    await releaseWheelSpin(emailKey);
  }

  const ipHash = hashIp(ip);
  const since = Math.floor(Date.now() / 1000) - 86_400;
  if ((await countWheelSpinsForIp(ipHash, since)) >= SPINS_PER_IP_PER_DAY) return json(429, { success: false, error: "ip" });

  const index = drawPrizeIndex();
  const prize = WHEEL_PRIZES[index];
  if (!(await reserveWheelSpin({ emailKey, email, prizeKey: prize.key, ipHash, locale }))) {
    const again = await getWheelSpin(emailKey);
    const idx = again ? WHEEL_PRIZES.findIndex((p) => p.key === again.prize_key) : -1;
    if (again?.code && idx >= 0) return json(200, result(idx, null, again.expires_at, true));
    return json(409, { success: false, error: "busy" });
  }

  let created: { code: string; discountId: string; endsAt: string };
  try {
    created = await createWheelDiscount(prize);
  } catch (err) {
    console.error(`[roue] code creation failed: ${err}`);
    await releaseWheelSpin(emailKey);
    return json(502, { success: false, error: "code" });
  }
  const expiresAt = Math.floor(new Date(created.endsAt).getTime() / 1000);
  try {
    await setWheelSpinCode(emailKey, created.code, created.discountId, expiresAt);
  } catch (err) {
    // The code exists on Shopify but not in our table: log it so it can be found, and still give it to the visitor.
    console.error(`[roue] could not store code ${created.code} (${created.discountId}) for ${emailKey}: ${err}`);
  }

  // Best effort: the visitor already sees the code on screen, so a Klaviyo hiccup must not fail the spin.
  // No consent → nothing goes to Klaviyo: the event drives the 3 reminder emails, which need consent.
  if (consent) try {
    const listId = await getSetting("roue_klaviyo_list_id");
    const sub = await subscribeWheelProfile(email, listId);
    if (!sub.ok) console.warn(`[roue] Klaviyo subscribe failed: ${sub.status} ${sub.error}`);
    const ev = await trackWheelWin(email, {
      code: created.code,
      prize_fr: prize.labelFr,
      prize_en: prize.labelEn,
      amount: prize.amount,
      min_subtotal: prize.minSubtotal,
      expires_at: created.endsAt,
      locale,
      apply_url_fr: `https://ameublodirect.ca/discount/${created.code}?redirect=/collections/all`,
      apply_url_en: `https://ameublodirect.ca/discount/${created.code}?redirect=/en/collections/all`,
    });
    if (!ev.ok) console.warn(`[roue] Klaviyo event failed: ${ev.status} ${ev.error}`);
  } catch (err) {
    console.warn(`[roue] Klaviyo failed: ${err}`);
  }

  return json(200, result(index, created.code, expiresAt, false));
}
