import { NextResponse } from "next/server";
import { getRecentPriceChanges } from "@/lib/database";

/**
 * GET /api/insights — Price changes and trends.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50), 200);

    const changes = getRecentPriceChanges(limit);
    return NextResponse.json({ success: true, data: { changes } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[API] /api/insights failed: ${message}`);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
