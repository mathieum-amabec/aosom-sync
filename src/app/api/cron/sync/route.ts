import crypto from "crypto";
import { NextResponse } from "next/server";
import { runSync } from "@/jobs/job1-sync";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Cron handler — runs daily sync.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runSync();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Sync failed:`, err);
    return NextResponse.json({ success: false, error: "Sync failed" }, { status: 500 });
  }
}

export const maxDuration = 300;
