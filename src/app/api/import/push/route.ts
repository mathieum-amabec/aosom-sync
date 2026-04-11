import { NextResponse } from "next/server";
import { importToShopify } from "@/lib/import-pipeline";
import { checkRateLimit } from "@/lib/rate-limiter";

export async function POST(request: Request) {
  try {
    // Rate limit: 60 Shopify API calls per minute
    const { allowed, retryAfterMs } = checkRateLimit("shopify-push", 60, 60_000);
    if (!allowed) {
      return NextResponse.json(
        { success: false, error: "Rate limit exceeded. Try again shortly.", retryAfter: Math.ceil(retryAfterMs / 1000) },
        { status: 429 }
      );
    }

    const { jobId, content } = await request.json();
    if (!jobId || typeof jobId !== "string" || jobId.length > 100) {
      return NextResponse.json({ success: false, error: "Valid jobId required" }, { status: 400 });
    }
    const job = await importToShopify(jobId, content);
    return NextResponse.json({ success: true, data: job });
  } catch (err) {
    console.error(`[API] /api/import/push failed:`, err);
    return NextResponse.json({ success: false, error: "Import to Shopify failed" }, { status: 500 });
  }
}

export const maxDuration = 60;
