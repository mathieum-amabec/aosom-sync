import crypto from "crypto";
import { NextResponse } from "next/server";
import { processScheduledDrafts } from "@/jobs/job4-social";
import { isAuthenticated } from "@/lib/auth";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** Vercel cron trigger — Bearer CRON_SECRET required. */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processScheduledDrafts();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Scheduled posts processing failed:`, err);
    return NextResponse.json({ success: false, error: "Scheduled posts processing failed" }, { status: 500 });
  }
}

/** Manual trigger — valid session cookie required. */
export async function POST(_request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processScheduledDrafts();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[CRON] Scheduled posts processing failed:`, err);
    return NextResponse.json({ success: false, error: "Scheduled posts processing failed" }, { status: 500 });
  }
}

export const maxDuration = 120;
