import { NextResponse } from "next/server";
import { runDailySync } from "@/lib/sync-engine";

/**
 * Vercel Cron handler — runs daily sync.
 * Configured in vercel.json to run once per day.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  // Verify cron secret (Vercel sets this automatically for cron jobs)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runDailySync();
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

export const maxDuration = 300; // 5 min max for Vercel Pro
