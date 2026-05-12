import { ensureSchema } from "@/lib/database";

export const SYNC_LOCK_KEY = "sync_full_lock";
export const SYNC_LOCK_TTL_SECONDS = 900; // 15 min — must exceed maxDuration (800s)

export interface SyncLockStatus {
  holder: string;
  acquiredAt: number; // Unix timestamp
  ageSeconds: number;
}

function deriveSyncHolder(): string {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  if (h === 6 && m < 15) return "cron-06-00";
  if (h === 6 && m >= 25 && m < 45) return "cron-06-30";
  return `manual-${Date.now()}`;
}

/**
 * Try to acquire the sync full lock atomically.
 * Returns the holder string if acquired, null if already held by another process.
 * Auto-clears stale locks older than ttlSeconds via a single atomic batch.
 */
export async function tryAcquireSyncLock(
  ttlSeconds: number = SYNC_LOCK_TTL_SECONDS
): Promise<string | null> {
  const db = await ensureSchema();
  const holder = deriveSyncHolder();

  // Atomic batch: delete stale lock first, then insert if slot is free.
  // Both statements run in a single transaction — no race window.
  const results = await db.batch(
    [
      {
        sql: `DELETE FROM settings WHERE key=? AND (strftime('%s','now') - updated_at) > ?`,
        args: [SYNC_LOCK_KEY, ttlSeconds],
      },
      {
        sql: `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
        args: [SYNC_LOCK_KEY, holder],
      },
    ],
    "write"
  );

  const acquired = (results[1].rowsAffected ?? 0) === 1;
  if (!acquired) {
    const status = await getSyncLockStatus();
    console.warn(
      `[sync-lock] Lock held by "${status?.holder ?? "unknown"}" for ${status?.ageSeconds ?? "?"}s — skipping`
    );
  }
  return acquired ? holder : null;
}

/**
 * Release the sync lock. Only releases if this process is the holder.
 * Idempotent: safe to call even if lock was already released or never held.
 */
export async function releaseSyncLock(holder: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({
    sql: `DELETE FROM settings WHERE key=? AND value=?`,
    args: [SYNC_LOCK_KEY, holder],
  });
}

/**
 * Get current lock status for monitoring / debug.
 */
export async function getSyncLockStatus(): Promise<SyncLockStatus | null> {
  const db = await ensureSchema();
  const result = await db.execute({
    sql: `SELECT value, updated_at FROM settings WHERE key=?`,
    args: [SYNC_LOCK_KEY],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const holder = String(row[0] ?? row["value"] ?? "");
  const acquiredAt = Number(row[1] ?? row["updated_at"] ?? 0);
  return {
    holder,
    acquiredAt,
    ageSeconds: Math.floor(Date.now() / 1000) - acquiredAt,
  };
}
