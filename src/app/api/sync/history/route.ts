import { NextResponse } from "next/server";
import { getSyncRuns, getSyncLogs, getRecentPriceChanges } from "@/lib/database";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId");

    if (runId) {
      const logs = await getSyncLogs(runId, 1000);
      return NextResponse.json({ success: true, data: { logs } });
    }

    const runs = await getSyncRuns(50);
    const recentChanges = await getRecentPriceChanges(20);
    return NextResponse.json({ success: true, data: { runs, recentChanges } });
  } catch (err) {
    console.error(`[API] /api/sync/history failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
