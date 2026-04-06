import { NextResponse } from "next/server";
import { triggerStockHighlight } from "@/jobs/job4-social";
import { env } from "@/lib/config";

/**
 * Cron handler — daily stock highlight post generation.
 * Protected by CRON_SECRET header.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${env.cronSecret}`) {
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
