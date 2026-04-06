/**
 * Legacy sync engine — redirects to job1-sync.ts
 * Kept for backward compatibility with existing UI components.
 */
export { runSync as runDailySync } from "@/jobs/job1-sync";
export type { SyncResult } from "@/jobs/job1-sync";
