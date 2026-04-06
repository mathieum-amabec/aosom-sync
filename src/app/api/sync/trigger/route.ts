import { NextResponse } from "next/server";
import { runSync } from "@/jobs/job1-sync";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun === true;

    const result = await runSync({ dryRun });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[JOB1] Sync failed: ${message}`);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 300;
