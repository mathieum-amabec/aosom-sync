import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDemandGenAssets } from "@/lib/database";

/**
 * GET /api/demand-gen-videos — Demand Gen video assets for the dashboard table.
 *
 * Auth-gated (session cookie). Reads `video_demand_gen` via getDemandGenAssets()
 * and returns a lean DTO per asset plus per-platform upload flags and roll-up
 * counters. The full blob_url is surfaced (it's the public Vercel Blob source the
 * ad-push jobs read) only when it's https, to avoid mixed-content links.
 *
 * Read-only: uploads are done by scripts/upload-meta-advideos.mjs and
 * scripts/upload-youtube.mjs, not from the dashboard.
 */

export interface DemandGenAssetDTO {
  id: number;
  sku: string;
  titleFr: string | null;
  ratio: string;
  durationSec: number;
  bytes: number | null;
  blobUrl: string; // "" when not an https URL
  metaUploaded: boolean;
  youtubeUploaded: boolean;
}

export interface DemandGenCounts {
  total: number;
  meta: number;
  youtube: number;
}

export async function GET() {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const assets = await getDemandGenAssets();
    const data: DemandGenAssetDTO[] = assets.map((a) => ({
      id: a.id,
      sku: a.sku,
      titleFr: a.titleFr,
      ratio: a.ratio,
      durationSec: a.durationSec,
      bytes: a.bytes,
      blobUrl: a.blobUrl.startsWith("https://") ? a.blobUrl : "",
      metaUploaded: a.metaVideoId != null && a.metaVideoId !== "",
      youtubeUploaded: a.youtubeVideoId != null && a.youtubeVideoId !== "",
    }));
    const counts: DemandGenCounts = {
      total: data.length,
      meta: data.filter((d) => d.metaUploaded).length,
      youtube: data.filter((d) => d.youtubeUploaded).length,
    };
    return NextResponse.json({ success: true, data, counts });
  } catch (err) {
    console.error("[API] /api/demand-gen-videos GET failed:", err);
    return NextResponse.json(
      { success: false, error: "Failed to load demand gen videos" },
      { status: 500 },
    );
  }
}
