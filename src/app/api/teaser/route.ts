/**
 * POST /api/teaser — "bientôt" teaser interest event from the storefront (see src/lib/teaser.ts).
 *
 * Body: { f: "visualiser"|"decorateur", e: "view"|"click"|"yes"|"no"|"email", s: "pdp"|"sheet"|"chat",
 *         v: <browser visitor id>, h?: product handle, l?: "fr"|"en", email?: string (only with e = "email") }
 * Each (feature, event, source) counts once per visitor. An email is stored, with the consent wording shown, for
 * ONE launch notice — no newsletter, no Klaviyo profile. Answers 204 on success.
 */
import { NextResponse } from "next/server";
import { insertTeaserEvent, upsertTeaserSignup } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { storefrontCors } from "@/lib/storefront-cors";
import { CONSENT_TEXT, hashVisitor, isTeaserEvent, isTeaserFeature, isTeaserSource, isVisitorId } from "@/lib/teaser";
import { isValidEmail, normalizeEmailKey } from "@/lib/welcome-wheel";
import { isValidHandle } from "@/lib/room-visualizer";

export const runtime = "nodejs";

const MAX_BODY = 2048;

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: storefrontCors(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const cors = storefrontCors(request.headers.get("origin"));
  const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: cors });
  if (!cors["Access-Control-Allow-Origin"]) return json(403, { success: false, error: "origin" });
  if (!checkRateLimit(`teaser:${clientIp(request)}`, 30, 60_000).allowed) return json(429, { success: false, error: "rate" });
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return json(413, { success: false, error: "size" });

  let body: Record<string, unknown>;
  try {
    // The theme posts text/plain (no CORS preflight); parse the raw text either way.
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { success: false, error: "size" });
    body = JSON.parse(raw);
  } catch {
    return json(400, { success: false, error: "json" });
  }
  if (!body || typeof body !== "object") return json(400, { success: false, error: "json" });
  const { f, e, s, v } = body;
  if (!isTeaserFeature(f) || !isTeaserEvent(e) || !isTeaserSource(s) || !isVisitorId(v)) return json(400, { success: false, error: "fields" });
  const handle = isValidHandle(body.h) ? body.h : null;
  const locale = body.l === "en" ? "en" : "fr";

  try {
    if (e === "email") {
      if (!isValidEmail(body.email)) return json(400, { success: false, error: "email" });
      const email = body.email.trim().toLowerCase();
      await upsertTeaserSignup({ feature: f, emailKey: normalizeEmailKey(email), email, source: s, consentText: CONSENT_TEXT[locale], locale, handle });
    }
    await insertTeaserEvent({ feature: f, event: e, source: s, visitorHash: hashVisitor(v), handle, locale });
  } catch (err) {
    console.error(`[teaser] write failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(500, { success: false, error: "db" });
  }
  return new NextResponse(null, { status: 204, headers: cors });
}
