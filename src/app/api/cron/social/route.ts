import crypto from "crypto";
import { NextResponse } from "next/server";
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

  // DISABLED: waiting for image attachments feature (product posts need images)
  return NextResponse.json({ success: true, data: null, skipped: "stock_highlight disabled until image attachments feature is built" });
}

export const maxDuration = 200;
