import { NextResponse } from "next/server";
import { importToShopify } from "@/lib/import-pipeline";

export async function POST(request: Request) {
  try {
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
