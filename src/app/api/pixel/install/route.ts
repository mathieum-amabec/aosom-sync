import { NextResponse } from "next/server";
import { installPixel, removePixel, getPixelStatus, PIXEL_SCRIPT_PATH } from "@/lib/meta-pixel";
import {
  installPinterestPixel,
  removePinterestPixel,
  getPinterestPixelStatus,
  PINTEREST_SCRIPT_PATH,
} from "@/lib/pinterest-pixel";
import { env } from "@/lib/config";

// Auth: enforced centrally by src/proxy.ts (session required; /api/pixel/install
// is NOT in PUBLIC_PATHS and NOT in the reviewer allowlist, so reviewers get 403).
//
// Manages BOTH storefront tags — the Meta pixel ScriptTag and the Pinterest tag
// ScriptTag — since they are parallel infrastructure. The Meta fields
// (scriptTagId / src / pixelConfigured) stay top-level for backward compatibility;
// Pinterest is reported under `pinterest`.

/** GET — current install status of both tags + whether each ID env var is set. */
export async function GET() {
  try {
    const [meta, pinterest] = await Promise.all([getPixelStatus(), getPinterestPixelStatus()]);
    return NextResponse.json({
      success: true,
      ...meta,
      pixelConfigured: env.hasMetaPixel,
      pinterest: { ...pinterest, configured: env.hasPinterestTag },
    });
  } catch (err) {
    console.error("[API] /api/pixel/install GET failed:", err);
    return NextResponse.json({ success: false, error: "Failed to read pixel status" }, { status: 500 });
  }
}

/** POST — install (idempotent) both ScriptTags pointing at this app's script endpoints. */
export async function POST(request: Request) {
  try {
    // Derive the script URLs from the request origin so it works on any
    // deployment (production alias, preview) without a hardcoded domain.
    const origin = new URL(request.url).origin;
    const [metaTag, pinterestTag] = await Promise.all([
      installPixel(`${origin}${PIXEL_SCRIPT_PATH}`),
      installPinterestPixel(`${origin}${PINTEREST_SCRIPT_PATH}`),
    ]);
    return NextResponse.json({
      success: true,
      scriptTagId: metaTag.id,
      src: metaTag.src,
      pixelConfigured: env.hasMetaPixel,
      pinterest: { scriptTagId: pinterestTag.id, src: pinterestTag.src, configured: env.hasPinterestTag },
    });
  } catch (err) {
    console.error("[API] /api/pixel/install POST failed:", err);
    return NextResponse.json({ success: false, error: "Failed to install pixel" }, { status: 500 });
  }
}

/** DELETE — uninstall all of our Meta + Pinterest ScriptTags. */
export async function DELETE() {
  try {
    const [removed, pinterestRemoved] = await Promise.all([removePixel(), removePinterestPixel()]);
    return NextResponse.json({ success: true, removed, pinterestRemoved });
  } catch (err) {
    console.error("[API] /api/pixel/install DELETE failed:", err);
    return NextResponse.json({ success: false, error: "Failed to uninstall pixel" }, { status: 500 });
  }
}
