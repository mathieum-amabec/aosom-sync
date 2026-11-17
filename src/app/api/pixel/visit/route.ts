/**
 * POST /api/pixel/visit — first visit vs return beacon from the storefront pixel script (see src/lib/visitor-tracking.ts).
 *
 * Body (text/plain JSON, sent with navigator.sendBeacon):
 *   { t: "visit"|"atc"|"checkout", v: <browser visitor id>, n: <visit number>,
 *     p?: 1 (id predates counting), f?: <first-seen ms>, g?: <days since previous visit>, u?: <page URL>, r?: <referrer> }
 * Public (allow-listed in proxy.ts), storefront Origin only, per-IP rate limit, strict validation. Stores nothing when
 * the setting `visit_tracking` = "0". Always answers fast; a failure never reaches the shopper (beacons ignore replies).
 */
import { NextResponse } from "next/server";
import { getSetting, insertVisitorSession, markVisitorSession } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { storefrontCors } from "@/lib/storefront-cors";
import { deviceOf, hashVisitorId, isBotUserAgent, isVisitEvent, isVisitNumber, isVisitorId, parseLanding, referrerHost } from "@/lib/visitor-tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 2048;

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: storefrontCors(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const cors = storefrontCors(request.headers.get("origin"));
  const reply = (status: number) => new NextResponse(null, { status, headers: cors });
  if (!cors["Access-Control-Allow-Origin"]) return reply(403);
  if (!checkRateLimit(`visit:${clientIp(request)}`, 60, 60_000).allowed) return reply(429);
  const ua = request.headers.get("user-agent");
  if (isBotUserAgent(ua)) return reply(204);

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413);
    body = JSON.parse(raw);
  } catch {
    return reply(400);
  }
  if (!body || typeof body !== "object") return reply(400);
  const { t, v, n } = body;
  if (!isVisitEvent(t) || !isVisitorId(v) || !isVisitNumber(n)) return reply(400);

  try {
    if ((await getSetting("visit_tracking")) === "0") return reply(204);
    const country = (request.headers.get("x-vercel-ip-country") || "").toUpperCase().slice(0, 2) || null;
    const device = deviceOf(ua);
    const visitorHash = hashVisitorId(v);
    if (t === "visit") {
      const landing = typeof body.u === "string" ? parseLanding(body.u) : null;
      const f = typeof body.f === "number" && Number.isFinite(body.f) && body.f > 1.6e12 && body.f < 4e12 ? Math.floor(body.f / 1000) : null;
      const g = typeof body.g === "number" && Number.isFinite(body.g) && body.g >= 0 && body.g < 10_000 ? Math.round(body.g * 100) / 100 : null;
      await insertVisitorSession({
        visitorHash, visitN: n, pre: body.p === 1, firstSeen: f, gapDays: g,
        host: landing?.host ?? null, landing: landing?.path ?? null, referrer: referrerHost(body.r),
        utmSource: landing?.utm ?? null, fbclid: landing?.fbclid ?? false, country, device,
      });
    } else {
      await markVisitorSession(visitorHash, n, t, { country, device });
    }
  } catch (err) {
    console.warn(`[visit] write failed: ${err instanceof Error ? err.message : String(err)}`);
    return reply(204);
  }
  return reply(204);
}
