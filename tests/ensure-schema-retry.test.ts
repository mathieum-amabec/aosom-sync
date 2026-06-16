import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import {
  initSchema,
  __setInitSchemaImplForTests,
  __getSchemaPromiseForTests,
} from "@/lib/database";

// Issue #186: initSchema() memoizes its in-flight promise so concurrent callers
// share one schema-init. The fix is that a *failed* init nulls the memoized promise
// so the next caller retries, instead of every future caller awaiting the same
// cached rejection until the next cold start. These tests inject a fail-once-then-
// succeed impl through the DI seam to prove that retry/reset contract end-to-end.
describe("initSchema retry-after-failure (#186)", () => {
  // Restore the real implementation (and clear module state) after every test.
  afterEach(() => __setInitSchemaImplForTests());

  it("nulls the memoized promise after a failed init so the next call retries", async () => {
    let calls = 0;
    __setInitSchemaImplForTests(async () => {
      calls++;
      throw new Error("transient init failure");
    });

    // First attempt rejects...
    await expect(initSchema()).rejects.toThrow("transient init failure");
    // ...and the cached rejection is cleared (requirement 1).
    expect(__getSchemaPromiseForTests()).toBeNull();

    // The next call re-invokes the impl rather than re-throwing the cached reject.
    await expect(initSchema()).rejects.toThrow("transient init failure");
    expect(calls).toBe(2);
  });

  it("recovers on retry and leaves the DB accessible", async () => {
    // A real in-memory client stands in for "the DB" the impl initializes; the
    // success path creates a probe table on it so we can confirm normal access
    // afterward without touching the production getDb() file singleton.
    const db = createClient({ url: ":memory:" });
    let calls = 0;
    __setInitSchemaImplForTests(async () => {
      calls++;
      if (calls === 1) throw new Error("transient init failure");
      await db.execute(`CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, v TEXT)`);
      await db.execute({ sql: `INSERT INTO probe (v) VALUES (?)`, args: ["ok"] });
    });

    // First attempt fails and resets, exactly as in the test above.
    await expect(initSchema()).rejects.toThrow("transient init failure");
    expect(__getSchemaPromiseForTests()).toBeNull();

    // Second attempt retries and succeeds (requirement 2).
    await expect(initSchema()).resolves.toBeUndefined();
    expect(calls).toBe(2);

    // The success is memoized — a third call does not re-run init.
    await initSchema();
    expect(calls).toBe(2);
    expect(__getSchemaPromiseForTests()).not.toBeNull();

    // The DB initialized by the successful retry is accessible normally.
    const { rows } = await db.execute(`SELECT v FROM probe`);
    expect(rows).toHaveLength(1);
    expect(rows[0].v).toBe("ok");
    db.close();
  });
});
