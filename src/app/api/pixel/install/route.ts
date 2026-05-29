import { NextResponse } from "next/server";
import { installPixel, removePixel, getPixelStatus, PIXEL_SCRIPT_PATH } from "@/lib/meta-pixel";
import { env } from "@/lib/config";

// Auth: enforced centrally by src/proxy.ts (session required; /api/pixel/install
// is NOT in PUBLIC_PATHS and NOT in the reviewer allowlist, so reviewers get 403).

/** GET — current install status + whether the pixel ID env var is set. */
export async function GET() {
  try {
    const status = await getPixelStatus();
    return NextResponse.json({ success: true, ...status, pixelConfigured: env.hasMetaPixel });
  } catch (err) {
    console.error("[API] /api/pixel/install GET failed:", err);
    return NextResponse.json({ success: false, error: "Failed to read pixel status" }, { status: 500 });
  }
}

/** POST — install (idempotent) the pixel ScriptTag pointing at this app's script endpoint. */
export async function POST(request: Request) {
  try {
    // Derive the script URL from the request origin so it works on any
    // deployment (production alias, preview) without a hardcoded domain.
    const origin = new URL(request.url).origin;
    const scriptSrc = `${origin}${PIXEL_SCRIPT_PATH}`;
    const tag = await installPixel(scriptSrc);
    return NextResponse.json({
      success: true,
      scriptTagId: tag.id,
      src: tag.src,
      pixelConfigured: env.hasMetaPixel,
    });
  } catch (err) {
    console.error("[API] /api/pixel/install POST failed:", err);
    return NextResponse.json({ success: false, error: "Failed to install pixel" }, { status: 500 });
  }
}

/** DELETE — uninstall all of our pixel ScriptTags. */
export async function DELETE() {
  try {
    const removed = await removePixel();
    return NextResponse.json({ success: true, removed });
  } catch (err) {
    console.error("[API] /api/pixel/install DELETE failed:", err);
    return NextResponse.json({ success: false, error: "Failed to uninstall pixel" }, { status: 500 });
  }
}
