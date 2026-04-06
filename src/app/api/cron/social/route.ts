import crypto from "crypto";
import { NextResponse } from "next/server";
import { triggerStockHighlight } from "@/jobs/job4-social";
import { env } from "@/lib/config";

function verifyCronSecret(header: string | null): boolean {
  if (!header) return false;
  const expected = `Bearer ${env.cronSecret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/**
 * Cron handler — daily stock highlight post generation.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await triggerStockHighlight();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[CRON] Social highlight failed: ${message}`);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const maxDuration = 120;
