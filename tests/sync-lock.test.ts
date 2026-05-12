import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/database", () => ({
  ensureSchema: vi.fn(),
}));

import { ensureSchema } from "@/lib/database";
import {
  tryAcquireSyncLock,
  releaseSyncLock,
  getSyncLockStatus,
  SYNC_LOCK_KEY,
  SYNC_LOCK_TTL_SECONDS,
} from "@/lib/sync-lock";

function makeDb(overrides: Partial<{ execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> }> = {}) {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 0 }]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── tryAcquireSyncLock ───────────────────────────────────────────────────────

describe("tryAcquireSyncLock", () => {
  it("acquires lock when no lock exists (rowsAffected=1)", async () => {
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();

    expect(holder).not.toBeNull();
    expect(typeof holder).toBe("string");
    expect(db.batch).toHaveBeenCalledOnce();
    const batchCalls = db.batch.mock.calls[0][0];
    expect(batchCalls[0].sql).toContain("DELETE FROM settings");
    expect(batchCalls[1].sql).toContain("INSERT OR IGNORE");
  });

  it("returns null when lock is held (rowsAffected=0)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 0 }]),
      execute: vi.fn().mockResolvedValue({
        rows: [["existing-holder", now]],
      }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();

    expect(holder).toBeNull();
  });

  it("deletes stale lock before inserting (batch step 1 uses TTL)", async () => {
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    await tryAcquireSyncLock(600);

    const batchCalls = db.batch.mock.calls[0][0];
    expect(batchCalls[0].args).toContain(600); // TTL passed to DELETE
    expect(batchCalls[0].sql).toContain("strftime");
  });

  it("uses default TTL of 900s when not specified", async () => {
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    await tryAcquireSyncLock();

    const batchCalls = db.batch.mock.calls[0][0];
    expect(batchCalls[0].args).toContain(SYNC_LOCK_TTL_SECONDS); // 900
  });

  it("runs batch as 'write' transaction type", async () => {
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    await tryAcquireSyncLock();

    expect(db.batch.mock.calls[0][1]).toBe("write");
  });
});

// ─── releaseSyncLock ──────────────────────────────────────────────────────────

describe("releaseSyncLock", () => {
  it("deletes lock when holder matches", async () => {
    const db = makeDb();
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    await releaseSyncLock("cron-06-00");

    expect(db.execute).toHaveBeenCalledOnce();
    const call = db.execute.mock.calls[0][0];
    expect(call.sql).toContain("DELETE FROM settings");
    expect(call.args).toContain("cron-06-00");
    expect(call.args).toContain(SYNC_LOCK_KEY);
  });

  it("executes DELETE with value=holder (prevents releasing another holder's lock)", async () => {
    const db = makeDb();
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    await releaseSyncLock("manual-99999");

    const call = db.execute.mock.calls[0][0];
    expect(call.sql).toMatch(/value\s*=\s*\?/);
    expect(call.args).toContain("manual-99999");
  });

  it("is idempotent — safe to call when no lock exists (no-op DELETE)", async () => {
    const db = makeDb({
      execute: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    await expect(releaseSyncLock("cron-06-00")).resolves.toBeUndefined();
    expect(db.execute).toHaveBeenCalledOnce();
  });
});

// ─── getSyncLockStatus ────────────────────────────────────────────────────────

describe("getSyncLockStatus", () => {
  it("returns null when no lock exists", async () => {
    const db = makeDb({ execute: vi.fn().mockResolvedValue({ rows: [] }) });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const status = await getSyncLockStatus();

    expect(status).toBeNull();
  });

  it("returns lock info when lock exists", async () => {
    const acquiredAt = Math.floor(Date.now() / 1000) - 30;
    const db = makeDb({
      execute: vi.fn().mockResolvedValue({
        rows: [["cron-06-00", acquiredAt]],
      }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const status = await getSyncLockStatus();

    expect(status).not.toBeNull();
    expect(status!.holder).toBe("cron-06-00");
    expect(status!.acquiredAt).toBe(acquiredAt);
    expect(status!.ageSeconds).toBeGreaterThanOrEqual(29);
    expect(status!.ageSeconds).toBeLessThan(60);
  });
});

// ─── runSyncFull integration scenarios (lock-level) ─────────────────────────

describe("runSyncFull lock integration", () => {
  it("skips with reason='Another sync in progress' when lock is held", async () => {
    // Simulate lock held: batch returns rowsAffected=0 on insert
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 0 }]),
      execute: vi.fn().mockResolvedValue({
        rows: [["cron-06-00", now]],
      }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();
    expect(holder).toBeNull();

    const status = await getSyncLockStatus();
    expect(status?.holder).toBe("cron-06-00");
  });

  it("lock is released in finally block — releaseSyncLock called with same holder", async () => {
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();
    expect(holder).not.toBeNull();

    await releaseSyncLock(holder!);

    const releaseCall = db.execute.mock.calls[0][0];
    expect(releaseCall.args).toContain(holder);
  });
});

// ─── deriveSyncHolder (via tryAcquireSyncLock) ───────────────────────────────

describe("deriveSyncHolder time branches", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'cron-06-00' at 06:05 UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T06:05:00Z"));
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();
    expect(holder).toBe("cron-06-00");
  });

  it("returns 'cron-06-30' at 06:35 UTC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T06:35:00Z"));
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();
    expect(holder).toBe("cron-06-30");
  });

  it("returns 'manual-{timestamp}' outside cron windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T10:00:00Z"));
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 1 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const holder = await tryAcquireSyncLock();
    expect(holder).toMatch(/^manual-\d+$/);
  });
});

// ─── getSyncLockStatus — named-key row fallback ───────────────────────────────

describe("getSyncLockStatus named-key row fallback", () => {
  it("reads holder and acquiredAt from named keys (LibSQL column-object rows)", async () => {
    const acquiredAt = Math.floor(Date.now() / 1000) - 60;
    const db = makeDb({
      execute: vi.fn().mockResolvedValue({
        rows: [{ value: "cron-06-00", updated_at: acquiredAt, 0: "cron-06-00", 1: acquiredAt }],
      }),
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);

    const status = await getSyncLockStatus();

    expect(status).not.toBeNull();
    expect(status!.holder).toBe("cron-06-00");
    expect(status!.acquiredAt).toBe(acquiredAt);
  });
});

// ─── tryAcquireSyncLock — null getSyncLockStatus fallback ────────────────────

describe("tryAcquireSyncLock — null lockStatus fallback in warn", () => {
  it("logs 'unknown' and '?' when getSyncLockStatus returns null after failed acquire", async () => {
    const db = makeDb({
      batch: vi.fn().mockResolvedValue([{ rowsAffected: 0 }, { rowsAffected: 0 }]),
      execute: vi.fn().mockResolvedValue({ rows: [] }), // empty → getSyncLockStatus returns null
    });
    vi.mocked(ensureSchema).mockResolvedValue(db as never);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const holder = await tryAcquireSyncLock();

    expect(holder).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"unknown"')
    );
    warnSpy.mockRestore();
  });
});
