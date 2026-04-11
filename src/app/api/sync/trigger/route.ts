import { NextResponse } from "next/server";
import { runSync } from "@/jobs/job1-sync";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const shopifyPush = body.shopifyPush !== false;

    const result = await runSync({ dryRun, shopifyPush });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error(`[JOB1] Sync failed:`, err);
    return NextResponse.json({ success: false, error: "Sync failed" }, { status: 500 });
  }
}

export const maxDuration = 300;
