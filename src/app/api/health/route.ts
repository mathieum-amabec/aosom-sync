import { NextResponse } from "next/server";
import { getLatestSyncRun, clearStaleLockIfNeeded } from "@/lib/database";

export const dynamic = "force-dynamic";

export async function GET() {
  let dbOk = false;
  let lastSync: { timestamp: string | null; status: string; age_minutes: number } | null = null;

  try {
    // Self-heal orphaned runs. A Fluid Compute function killed by timeout (>800s) leaves its
    // sync_runs row stuck at status='running' until the NEXT sync calls clearStaleLockIfNeeded.
    // Between syncs that orphan would otherwise show here as a live "running" run for hours, so
    // sweep stale (>15 min, past the 13-min maxDuration) running rows on each health poll.
    // Best-effort: a sweep failure must never flip the health check to "down".
    try { await clearStaleLockIfNeeded(15); } catch { /* non-fatal */ }

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
