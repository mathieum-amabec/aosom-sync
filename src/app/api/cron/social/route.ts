import crypto from "crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/config";
import { triggerStockHighlight } from "@/jobs/job4-social";
import { trackCron } from "@/lib/cron-tracking";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Cron handler — daily stock highlight post generation.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Daily stock highlight: pick a random eligible product and generate a bilingual
  // draft. triggerStockHighlight captures the Aosom product images via pickRandomImages,
  // and the publisher falls back to products.image1 (JOIN) — so the post carries an image.
  try {
    const result = await trackCron("social", () => triggerStockHighlight());
    if (!result) {
      return NextResponse.json({ success: true, data: null, skipped: "no eligible product for stock highlight" });
    }
    return NextResponse.json({
      success: true,
      draftId: result.draftId,
      photos: result.imageUrls.length,
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[CRON/social] stock_highlight failed:", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export const maxDuration = 200;
