import crypto from "crypto";
import { NextResponse } from "next/server";
import { runSyncFull } from "@/jobs/job1-sync";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Cron handler — Fluid Compute single-function Phase 1 orchestrator.
 * Runs at 06:00 UTC (primary) and 06:30 UTC (idempotent retry).
 * maxDuration 800s on Vercel Pro Fluid Compute.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSyncFull();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Sync full failed:`, err);
    return NextResponse.json({ success: false, error: "Sync full failed" }, { status: 500 });
  }
}

export const maxDuration = 800;
