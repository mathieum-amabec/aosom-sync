import crypto from "crypto";
import { NextResponse } from "next/server";
import { runSyncRefreshChunk } from "@/jobs/job1-sync";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Cron handler — Phase 1 refresh chunk (writes one REFRESH_CHUNK_SIZE slice to DB).
 * Runs at 06:20, 06:40, 07:00, 07:20 UTC.
 * Is a no-op if no pending refresh work exists.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSyncRefreshChunk();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Sync refresh chunk failed:`, err);
    return NextResponse.json({ success: false, error: "Sync refresh failed" }, { status: 500 });
  }
}

export const maxDuration = 200;
