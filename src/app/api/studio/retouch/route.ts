import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { isAllowedMediaUrl } from "@/lib/studio/options";
import {
  buildRetouchPrompt,
  retouchImage,
  RetouchError,
  PRESETS,
  STAGE_SCENES,
  SEASONS,
  type RetouchPreset,
  type StageScene,
  type Season,
} from "@/lib/studio/ai-retouch";
import { addStudioImage, countAiImagesToday } from "@/lib/studio/db";
import { STUDIO_AI } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * POST /api/studio/retouch — AI-edit one product photo for the Studio.
 * Body: { sku, imageUrl, preset, scene?, season?, instruction?, productTitle? }
 * The result is saved to Blob (studio/ai/…) and to studio_images (source 'ai'), so it appears
 * in the product's Studio gallery tagged "IA". It never touches the Shopify product.
 */
export async function POST(request: Request) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  let b: Record<string, unknown>;
  try {
    b = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Requête invalide" }, { status: 400 });
  }
  const sku = typeof b.sku === "string" ? b.sku.trim().slice(0, 40) : "";
  const imageUrl = typeof b.imageUrl === "string" ? b.imageUrl : "";
  const preset = PRESETS.find((p) => p.id === b.preset)?.id as RetouchPreset | undefined;
  if (!sku || !isAllowedMediaUrl(imageUrl) || !preset) {
    return NextResponse.json({ success: false, error: "SKU, image ou type de retouche invalide" }, { status: 400 });
  }
  const prompt = buildRetouchPrompt({
    preset,
    scene: typeof b.scene === "string" && b.scene in STAGE_SCENES ? (b.scene as StageScene) : undefined,
    season: typeof b.season === "string" && b.season in SEASONS ? (b.season as Season) : undefined,
    instruction: typeof b.instruction === "string" ? b.instruction : undefined,
    productTitle: typeof b.productTitle === "string" ? b.productTitle.slice(0, 200) : undefined,
  });
  if (!prompt) return NextResponse.json({ success: false, error: "Écris une consigne pour la retouche libre" }, { status: 400 });

  const used = await countAiImagesToday();
  if (used >= STUDIO_AI.DAILY_CAP) {
    return NextResponse.json(
      { success: false, error: `Plafond quotidien atteint (${STUDIO_AI.DAILY_CAP} retouches IA). Réessaie demain.` },
      { status: 429 },
    );
  }

  try {
    const src = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
    if (!src.ok) throw new RetouchError(`Image source inaccessible (${src.status})`);
    const edited = await retouchImage(Buffer.from(await src.arrayBuffer()), prompt);
    const blob = await put(`studio/ai/${sku}/${preset}-${Date.now()}.jpg`, edited, {
      access: "public",
      contentType: "image/jpeg",
      addRandomSuffix: true,
    });
    const label = PRESETS.find((p) => p.id === preset)!.label;
    const detail = [b.scene, b.season, typeof b.instruction === "string" ? b.instruction.slice(0, 200) : null].filter(Boolean).join(" · ");
    const image = await addStudioImage({ sku, url: blob.url, source: "ai", parentUrl: imageUrl, prompt: detail ? `${label} — ${detail}` : label });
    return NextResponse.json({ success: true, data: image });
  } catch (err) {
    const status = err instanceof RetouchError ? err.status : 500;
    console.error("[API] /api/studio/retouch failed:", err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Retouche impossible" }, { status });
  }
}
