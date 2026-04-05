import { getSyncRuns, getLatestSyncRun } from "@/lib/database";
import { DashboardClient } from "./dashboard-client";
import type { SyncRun } from "@/types/sync";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  let recentRuns: SyncRun[] = [];
  let latestRun: SyncRun | null = null;
  try {
    recentRuns = getSyncRuns(5);
    latestRun = getLatestSyncRun();
  } catch {
    // DB not ready yet
  }

  return <DashboardClient recentRuns={recentRuns} latestRun={latestRun} />;
}
