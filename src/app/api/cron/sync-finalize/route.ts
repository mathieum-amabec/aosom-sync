import crypto from "crypto";
import { NextResponse } from "next/server";
import { runSyncFinalize } from "@/jobs/job1-sync";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Manual fallback — Phase 1 finalize (rebuildCounts + recordPriceChanges + notify).
 * No longer triggered by Vercel cron (removed in v0.4.0.0 — replaced by runSyncFull).
 * Kept as emergency manual fallback only.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSyncFinalize();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Sync finalize failed:`, err);
    return NextResponse.json({ success: false, error: "Sync finalize failed" }, { status: 500 });
  }
}

export const maxDuration = 60;
