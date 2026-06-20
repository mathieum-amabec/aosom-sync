import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// ─── Route: GET /api/cron/draft-ttl (auth + cron_runs tracking) ───────────────
vi.mock("@/lib/config", () => ({ env: { cronSecret: "test-secret-123" } }));
vi.mock("@/lib/database", () => ({ expireStaleNewProductDrafts: vi.fn(), recordCronRun: vi.fn() }));

import { GET } from "@/app/api/cron/draft-ttl/route";
import { expireStaleNewProductDrafts, recordCronRun } from "@/lib/database";

const expireMock = vi.mocked(expireStaleNewProductDrafts);
const recMock = vi.mocked(recordCronRun);
const auth = (s = "test-secret-123") =>
  new Request("https://app.test/api/cron/draft-ttl", { headers: { Authorization: `Bearer ${s}` } });

describe("GET /api/cron/draft-ttl", () => {
  beforeEach(() => {
    expireMock.mockReset().mockResolvedValue(85);
    recMock.mockReset().mockResolvedValue(undefined);
  });

  it("returns 401 and does nothing without auth", async () => {
    const res = await GET(new Request("https://app.test/api/cron/draft-ttl"));
    expect(res.status).toBe(401);
    expect(expireMock).not.toHaveBeenCalled();
    expect(recMock).not.toHaveBeenCalled();
  });

  it("expires stale drafts and records cron_runs 'expired=N' on success", async () => {
    const res = await GET(auth());
    expect(res.status).toBe(200);
    expect(expireMock).toHaveBeenCalledWith(7); // TTL_DAYS
    expect(recMock).toHaveBeenCalledWith("draft-ttl", "success", "expired=85");
    expect(await res.json()).toEqual({ success: true, expired: 85 });
  });

  it("records an error run and returns 500 when the expiry throws", async () => {
    expireMock.mockRejectedValue(new Error("DB down"));
    const res = await GET(auth());
    expect(res.status).toBe(500);
    expect(recMock).toHaveBeenCalledWith("draft-ttl", "error", "DB down");
  });
});

// ─── SQL logic mirror (in-memory): the TTL UPDATE from expireStaleNewProductDrafts ──
const TTL_SQL = `UPDATE facebook_drafts
  SET status = 'rejected', approved_at = strftime('%s','now'), reviewed_by = 'auto-ttl', review_notes = ?
  WHERE status = 'draft' AND trigger_type = 'new_product'
    AND created_at < unixepoch() - 86400 * ?`;

describe("draft-ttl UPDATE (direct SQL)", () => {
  let db: Client;
  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(`CREATE TABLE facebook_drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT, trigger_type TEXT, status TEXT DEFAULT 'draft',
      created_at INTEGER, approved_at INTEGER, reviewed_by TEXT, review_notes TEXT)`);
    const now = Math.floor(Date.now() / 1000);
    const d = (days: number) => now - days * 86400;
    await db.batch([
      { sql: `INSERT INTO facebook_drafts (sku,trigger_type,status,created_at) VALUES (?,?,?,?)`, args: ["A", "new_product", "draft", d(8)] },   // expire
      { sql: `INSERT INTO facebook_drafts (sku,trigger_type,status,created_at) VALUES (?,?,?,?)`, args: ["B", "new_product", "draft", d(6)] },   // too fresh → keep
      { sql: `INSERT INTO facebook_drafts (sku,trigger_type,status,created_at) VALUES (?,?,?,?)`, args: ["C", "stock_highlight", "draft", d(30)] }, // wrong type → keep
      { sql: `INSERT INTO facebook_drafts (sku,trigger_type,status,created_at) VALUES (?,?,?,?)`, args: ["D", "new_product", "approved", d(30)] }, // not draft → keep
    ]);
  });
  afterEach(() => db.close());

  it("rejects only stale (>7d) unapproved new_product drafts, with audit fields", async () => {
    const res = await db.execute({ sql: TTL_SQL, args: ["Auto-expiré: new_product >7j", 7] });
    expect(res.rowsAffected).toBe(1);

    const rows = (await db.execute(`SELECT sku, status, reviewed_by, review_notes FROM facebook_drafts ORDER BY sku`)).rows
      .map((r) => r as unknown as Record<string, unknown>);
    const bySku = Object.fromEntries(rows.map((r) => [r.sku, r]));
    expect(bySku.A).toMatchObject({ status: "rejected", reviewed_by: "auto-ttl", review_notes: "Auto-expiré: new_product >7j" });
    expect(bySku.B.status).toBe("draft"); // too fresh
    expect(bySku.C.status).toBe("draft"); // wrong type
    expect(bySku.D.status).toBe("approved"); // already approved — untouched
  });

  it("is idempotent — a second run rejects nothing", async () => {
    await db.execute({ sql: TTL_SQL, args: ["Auto-expiré: new_product >7j", 7] });
    const again = await db.execute({ sql: TTL_SQL, args: ["Auto-expiré: new_product >7j", 7] });
    expect(again.rowsAffected).toBe(0);
  });
});
