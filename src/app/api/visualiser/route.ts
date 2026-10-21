/**
 * /api/visualiser — "Voyez-le chez vous" (AI room visualiser). OFF until settings `visualiser_enabled` = "1".
 *
 * GET  → { visualiser, decorateur } — which features are live. The theme shows the "bientôt" teaser while false
 *        (edge-cached 2 min, so flipping a setting reaches the storefront within minutes).
 * POST { photo: base64, type: "image/jpeg"|…, w, h, handle, image?: variant photo URL, dims?: [w,d,h] cm,
 *        locale, website?: "" (honeypot) } → { success, image: data URL } | { success: false, error }
 * Order: origin → burst limit → OFF check (503, nothing spent) → input checks → atomic per-IP daily reservation →
 * product lookup → model. The photo is never stored or logged. See src/lib/room-visualizer.ts.
 */
import { NextResponse } from "next/server";
import { finishVisualiserUse, reserveVisualiserUse } from "@/lib/database";
import { checkRateLimit } from "@/lib/rate-limiter";
import { clientIp } from "@/lib/client-ip";
import { storefrontCors } from "@/lib/storefront-cors";
import { LlmBudgetExceededError } from "@/lib/llm-budget";
import {
  VISUALISER_PER_IP_PER_DAY,
  hashVisitorIp,
  isDecorateurOn,
  isValidHandle,
  isVisualiserOn,
  loadProduct,
  parseDimsCm,
  parsePhoto,
  placeInRoom,
} from "@/lib/room-visualizer";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function OPTIONS(request: Request) {
  return new NextResponse(null, { status: 204, headers: storefrontCors(request.headers.get("origin"), "GET, POST, OPTIONS") });
}

export async function GET(request: Request) {
  const [visualiser, decorateur] = await Promise.all([isVisualiserOn(), isDecorateurOn()]);
  return NextResponse.json(
    { visualiser, decorateur },
    { headers: { ...storefrontCors(request.headers.get("origin"), "GET, POST, OPTIONS"), "Cache-Control": "public, s-maxage=120, stale-while-revalidate=600" } },
  );
}

export async function POST(request: Request) {
  const cors = storefrontCors(request.headers.get("origin"));
  const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: cors });
  if (!cors["Access-Control-Allow-Origin"]) return json(403, { success: false, error: "origin" });

  const ip = clientIp(request);
  if (!checkRateLimit(`visualiser:${ip}`, 3, 60_000).allowed) return json(429, { success: false, error: "rate" });
  if (!(await isVisualiserOn())) return json(503, { success: false, error: "off" });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json(400, { success: false, error: "json" });
  }
  if (typeof body.website === "string" && body.website.trim() !== "") return json(400, { success: false, error: "photo" });
  const room = parsePhoto(body.photo, body.type);
  if (!room) return json(400, { success: false, error: "photo" });
  if (!isValidHandle(body.handle)) return json(400, { success: false, error: "product" });
  const handle = body.handle;
  const locale = body.locale === "en" ? "en" : "fr";

  // Atomic: parallel requests cannot all slip under the cap. The attempt counts whatever its outcome.
  const useId = await reserveVisualiserUse({ kind: "visualiser", ipHash: hashVisitorIp(ip), handle, cap: VISUALISER_PER_IP_PER_DAY, sinceSec: Math.floor(Date.now() / 1000) - 86_400 });
  if (useId == null) return json(429, { success: false, error: "daily" });

  let ok = false;
  try {
    const product = await loadProduct(handle, locale).catch(() => null);
    if (!product) return json(404, { success: false, error: "product" });
    const r = await placeInRoom({
      room,
      roomWidth: Number(body.w),
      roomHeight: Number(body.h),
      title: product.title,
      productImages: product.images,
      variantImage: typeof body.image === "string" ? body.image : null,
      dims: parseDimsCm(body.dims),
    });
    ok = r.ok;
    if (!r.ok || !r.image) return json(422, { success: false, error: r.reason ?? "no_image" });
    return json(200, { success: true, image: `data:${r.image.mimeType};base64,${r.image.data}` });
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) return json(503, { success: false, error: "busy" });
    console.error(`[visualiser] placement failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(502, { success: false, error: "model" });
  } finally {
    await finishVisualiserUse(useId, ok).catch((e) => console.warn(`[visualiser] usage not updated: ${e}`));
  }
}
