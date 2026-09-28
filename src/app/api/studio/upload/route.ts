import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireStudioAdmin } from "@/lib/studio/guard";
import { STUDIO_MUSIC_PREFIX } from "@/lib/studio/music";

/**
 * POST /api/studio/upload — issues a Vercel Blob client-upload token so the browser uploads
 * Mat's photo ("avant" style D) or a music track DIRECTLY to Blob (no 4.5 MB function body
 * limit). Only two destinations are allowed, each with its own type and size cap. No
 * onUploadCompleted callback: that webhook would hit src/proxy.ts without a session; the page
 * registers the uploaded photo itself via POST /api/studio/images.
 */
const RULES = [
  { prefix: "studio/uploads/", types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 20 * 1024 * 1024 },
  { prefix: STUDIO_MUSIC_PREFIX, types: ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav"], maxBytes: 25 * 1024 * 1024 },
];

export async function POST(request: Request) {
  const denied = await requireStudioAdmin();
  if (denied) return denied;
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  }
  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        const rule = RULES.find((r) => pathname.startsWith(r.prefix));
        if (!rule || pathname.includes("..")) throw new Error("Destination de téléversement non autorisée");
        return { allowedContentTypes: rule.types, maximumSizeInBytes: rule.maxBytes, addRandomSuffix: true };
      },
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Téléversement refusé" }, { status: 400 });
  }
}
