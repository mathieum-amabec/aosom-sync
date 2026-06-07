import { NextResponse } from "next/server";
import { getLatestSyncRun } from "@/lib/database";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  let lastSync: { timestamp: string | null; status: string; age_minutes: number } | null = null;

  try {
    const run = await getLatestSyncRun();
    dbOk = true;

    if (run) {
      const ageMs = Date.now() - new Date(run.startedAt).getTime();
      lastSync = {
        timestamp: run.startedAt,
        status: run.status,
        age_minutes: Math.round(ageMs / 60_000),
      };
    }
  } catch {
    dbOk = false;
  }

  let status: "ok" | "degraded" | "down" = "down";
  if (dbOk) {
    if (!lastSync || lastSync.status === "failed" || lastSync.age_minutes > 26 * 60) {
      status = "degraded";
    } else {
      status = "ok";
    }
  }

  // Deliberately no exact version: this endpoint is public (allow-listed in
  // proxy.ts), and leaking the precise build lets an attacker fingerprint it
  // against dependency CVEs. status/db/lastSync are enough for monitoring.
  return NextResponse.json({
    status,
    db: dbOk,
    lastSync,
  }, { status: status === "down" ? 503 : 200 });
}
