import { NextResponse } from "next/server";
import { runSync } from "@/jobs/job1-sync";
import { env } from "@/lib/config";

/**
 * Cron handler — runs daily sync.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSync();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CRON] Sync failed: ${message}`);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 300;
