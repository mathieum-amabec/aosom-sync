import crypto from "crypto";
import { NextResponse } from "next/server";
import { runSyncInit } from "@/jobs/job1-sync";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Cron handler — Phase 1 init (fetchAll + diff + save blob).
 * Fast: completes in <200s regardless of catalog size.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSyncInit();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Sync init failed:`, err);
    return NextResponse.json({ success: false, error: "Sync init failed" }, { status: 500 });
  }
}

export const maxDuration = 200;
