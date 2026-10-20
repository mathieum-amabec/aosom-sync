import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// The SQL behind reserveWheelSpin / releaseWheelSpin (database.ts) against an in-memory libsql DB, same approach as
// price-alerts-db.test.ts. The point: a second reservation for one email must affect 0 rows (one spin per person).

let db: Client;
const RESERVE = `INSERT INTO wheel_spins (email_key, email, prize_key, ip_hash, locale, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email_key) DO NOTHING`;

describe("wheel_spins SQL", () => {
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(`CREATE TABLE wheel_spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email_key TEXT NOT NULL UNIQUE, email TEXT NOT NULL, prize_key TEXT NOT NULL,
      code TEXT, discount_id TEXT, expires_at INTEGER, ip_hash TEXT, locale TEXT, created_at INTEGER NOT NULL)`);
  });

  it("reserves once per email; the second reservation affects 0 rows", async () => {
    const a = await db.execute({ sql: RESERVE, args: ["a@b.ca", "a@b.ca", "15-150", "ip", "fr", 1] });
    const b = await db.execute({ sql: RESERVE, args: ["a@b.ca", "A@b.ca", "100-1000", "ip", "fr", 2] });
    expect(a.rowsAffected).toBe(1);
    expect(b.rowsAffected).toBe(0);
    const row = await db.execute(`SELECT prize_key FROM wheel_spins`);
    expect(row.rows.map((r) => r.prize_key)).toEqual(["15-150"]);
  });

  it("release only deletes a reservation that never got a code", async () => {
    await db.execute({ sql: RESERVE, args: ["a@b.ca", "a@b.ca", "15-150", "ip", "fr", 1] });
    await db.execute({ sql: `UPDATE wheel_spins SET code = 'ROUE-X' WHERE email_key = ?`, args: ["a@b.ca"] });
    await db.execute({ sql: `DELETE FROM wheel_spins WHERE email_key = ? AND code IS NULL`, args: ["a@b.ca"] });
    expect((await db.execute(`SELECT COUNT(*) AS n FROM wheel_spins`)).rows[0].n).toBe(1);
  });
});
