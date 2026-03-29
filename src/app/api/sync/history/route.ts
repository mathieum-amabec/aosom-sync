import { NextResponse } from "next/server";
import { getSyncRuns, getSyncLogs } from "@/lib/database";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId");

    if (runId) {
      const logs = await getSyncLogs(runId, 1000);
      return NextResponse.json({ logs });
    }

    const runs = await getSyncRuns(50);
    return NextResponse.json({ runs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
