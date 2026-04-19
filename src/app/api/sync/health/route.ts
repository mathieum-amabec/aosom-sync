import { NextResponse } from "next/server";
import { getSyncRuns, getShopifyPushCheckpoint } from "@/lib/database";

export async function GET() {
  try {
    const [runs, checkpoint] = await Promise.all([
      getSyncRuns(10),
      getShopifyPushCheckpoint(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const todayRuns = runs.filter((r) => r.startedAt.startsWith(today));
    const latestPhase1 = todayRuns.find((r) => !r.errorMessages.includes("DB sync only — Shopify push deferred")) ?? todayRuns[0] ?? null;
    const zombies = runs.filter((r) => r.status === "running");

    const phase2Checkpoint = checkpoint?.date === today ? checkpoint : null;

    return NextResponse.json({
      success: true,
      data: {
        date: today,
        phase1: latestPhase1 ? {
          id: latestPhase1.id,
          status: latestPhase1.status,
          startedAt: latestPhase1.startedAt,
          completedAt: latestPhase1.completedAt,
          totalProducts: latestPhase1.totalProducts,
          updated: latestPhase1.updated,
          errors: latestPhase1.errors,
        } : null,
        phase2: phase2Checkpoint ? {
          done: phase2Checkpoint.done,
          processedDiffs: phase2Checkpoint.processedGroupKeys.length,
          totalDiffs: phase2Checkpoint.totalDiffs,
          totalUpdates: phase2Checkpoint.totalUpdates,
          totalArchived: phase2Checkpoint.totalArchived,
          totalErrors: phase2Checkpoint.totalErrors,
        } : { done: false, processedDiffs: 0, totalDiffs: 0, totalUpdates: 0, totalArchived: 0, totalErrors: 0 },
        zombies: zombies.map((r) => ({ id: r.id, startedAt: r.startedAt })),
        recentRuns: runs.slice(0, 5).map((r) => ({
          id: r.id,
          startedAt: r.startedAt,
          status: r.status,
          updated: r.updated,
          errors: r.errors,
        })),
      },
    });
  } catch (err) {
    console.error("[API] /api/sync/health failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
