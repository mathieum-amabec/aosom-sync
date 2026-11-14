/**
 * POST /api/decorateur — "Ameublo décorateur": a room photo → a short reading (room, style, colours) + live
 * products that suit it, picked by the shopping assistant. OFF until settings `decorateur_enabled` = "1"
 * (GET /api/visualiser reports it).
 *
 * Body: { photo: base64, type, locale, website?: "" } → { success, reply, products: [...], reading } | { success: false, error }
 * Same guards as /api/visualiser (origin, burst, OFF check, atomic DECORATEUR_PER_IP_PER_DAY reservation); both model
 * calls pay from the "decorateur" token pool, never the storefront chat's. Photo never stored.
 */
import { NextResponse } from "next/server";
import { finishVisualiserUse, reserveVisualiserUse } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { storefrontCors } from "@/lib/storefront-cors";
import { LlmBudgetExceededError } from "@/lib/llm-budget";
import { DECORATEUR_PER_IP_PER_DAY, decorateRoom, hashVisitorIp, isDecorateurOn, parsePhoto } from "@/lib/room-visualizer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: storefrontCors(request.headers.get("origin")) });
}

export async function POST(request: Request) {
  const cors = storefrontCors(request.headers.get("origin"));
  const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: cors });
  if (!cors["Access-Control-Allow-Origin"]) return json(403, { success: false, error: "origin" });

  const ip = clientIp(request);
  if (!checkRateLimit(`decorateur:${ip}`, 3, 60_000).allowed) return json(429, { success: false, error: "rate" });
  if (!(await isDecorateurOn())) return json(503, { success: false, error: "off" });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { success: false, error: "json" });
  }
  if (typeof body.website === "string" && body.website.trim() !== "") return json(400, { success: false, error: "photo" });
  const room = parsePhoto(body.photo, body.type);
  if (!room) return json(400, { success: false, error: "photo" });
  const locale = body.locale === "en" ? "en" : "fr";

  const useId = await reserveVisualiserUse({ kind: "decorateur", ipHash: hashVisitorIp(ip), handle: null, cap: DECORATEUR_PER_IP_PER_DAY, sinceSec: Math.floor(Date.now() / 1000) - 86_400 });
  if (useId == null) return json(429, { success: false, error: "daily" });

  let ok = false;
  try {
    const r = await decorateRoom(room, locale);
    ok = r.ok;
    if (!r.ok || !r.result) return json(422, { success: false, error: r.reason ?? "no_reading" });
    const { reply, products } = r.result;
    return json(200, { success: true, reply, products, reading: r.reading });
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) return json(503, { success: false, error: "busy" });
    console.error(`[decorateur] failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(502, { success: false, error: "model" });
  } finally {
    await finishVisualiserUse(useId, ok).catch((e) => console.warn(`[decorateur] usage not updated: ${e}`));
  }
}
