import { NextResponse } from "next/server";
import { runDailySync } from "@/lib/sync-engine";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const dryRun = body.dryRun === true;

    const result = await runDailySync({ dryRun });
    return NextResponse.json({
      ok: true,
      syncRunId: result.syncRun.id,
      summary: result.summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 300;
