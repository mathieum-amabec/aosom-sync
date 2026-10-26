/**
 * POST /api/capi/event — storefront relay for browser events → Meta Conversions API.
 *
 * The ScriptTag (src/app/api/pixel/script/route.ts) fires the browser pixel with an `eventID` and sends the SAME id
 * here, so Meta de-duplicates the two. Public (allow-listed in proxy.ts) and locked down: storefront-origin check,
 * per-IP rate limit, strict payload validation, only ViewContent/AddToCart. Does nothing unless the setting
 * `capi_enabled` = "1". Always answers quickly with 2xx so it can never slow the storefront.
 */
import { NextResponse } from "next/server";
import { STOREFRONT_ORIGINS } from "@/lib/storefront-cors";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { buildUserData, capiConfig, sendCapiEvents, type CapiEvent } from "@/lib/meta-capi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EVENTS = new Set(["ViewContent", "AddToCart"]);
const ID_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const FB_COOKIE_RE = /^fb\.[0-9]\.[0-9]{10,13}\.[A-Za-z0-9_.-]{4,200}$/;
const CUR_RE = /^[A-Za-z]{3}$/;

const cors = (origin: string | null): Record<string, string> => {
  const h: Record<string, string> = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" };
  if (origin && STOREFRONT_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
};

/** Full visitor IP for Meta matching (clientIp() buckets IPv6, fine for rate limits but not for matching). */
function rawIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const hops = (request.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] || null;
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: cors(request.headers.get("origin")) });
}

interface RelayBody {
  event_name?: unknown; event_id?: unknown; event_source_url?: unknown; fbp?: unknown; fbc?: unknown;
  custom_data?: { value?: unknown; currency?: unknown; content_ids?: unknown; content_type?: unknown; content_name?: unknown };
}

export async function POST(request: Request) {
  const headers = cors(request.headers.get("origin"));
  const done = (status: number, body: Record<string, unknown> = {}) => NextResponse.json(body, { status, headers });

  // sendBeacon posts text/plain: read as text, parse ourselves.
  let body: RelayBody;
  try {
    const raw = await request.text();
    if (raw.length > 4000) return done(413, { ok: false });
    body = JSON.parse(raw) as RelayBody;
  } catch {
    return done(400, { ok: false });
  }

  const name = typeof body.event_name === "string" ? body.event_name : "";
  const id = typeof body.event_id === "string" ? body.event_id : "";
  const url = typeof body.event_source_url === "string" ? body.event_source_url : "";
  if (!ALLOWED_EVENTS.has(name) || !ID_RE.test(id)) return done(400, { ok: false });
  let urlOrigin = "";
  try { urlOrigin = new URL(url).origin; } catch { return done(400, { ok: false }); }
  if (!STOREFRONT_ORIGINS.has(urlOrigin)) return done(403, { ok: false });

  if (!checkRateLimit(`capi:${clientIp(request)}`, 90, 60_000).allowed) return done(429, { ok: false });

  const cfg = await capiConfig();
  if (!cfg.enabled) return done(200, { ok: true, skipped: "disabled" });

  const cd = body.custom_data ?? {};
  const ids = Array.isArray(cd.content_ids) ? cd.content_ids.filter((x): x is string => typeof x === "string" && x.length <= 40).slice(0, 20) : [];
  const value = typeof cd.value === "number" && Number.isFinite(cd.value) && cd.value >= 0 && cd.value < 1_000_000 ? cd.value : undefined;
  const currency = typeof cd.currency === "string" && CUR_RE.test(cd.currency) ? cd.currency.toUpperCase() : undefined;
  const fbp = typeof body.fbp === "string" && FB_COOKIE_RE.test(body.fbp) ? body.fbp : null;
  const fbc = typeof body.fbc === "string" && FB_COOKIE_RE.test(body.fbc) ? body.fbc : null;

  const event: CapiEvent = {
    event_name: name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: id,
    event_source_url: url,
    action_source: "website",
    user_data: buildUserData({ ip: rawIp(request), userAgent: request.headers.get("user-agent"), fbp, fbc }),
    custom_data: {
      content_type: "product",
      ...(ids.length ? { content_ids: ids } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(currency ? { currency } : {}),
    },
  };
  try {
    const r = await sendCapiEvents([event], { testEventCode: cfg.testEventCode });
    if (!r.ok) console.warn(`[CAPI] relay ${name} failed: ${r.error}`);
    return done(200, { ok: r.ok });
  } catch (err) {
    console.warn("[CAPI] relay error:", err instanceof Error ? err.message : err);
    return done(200, { ok: false });
  }
}
