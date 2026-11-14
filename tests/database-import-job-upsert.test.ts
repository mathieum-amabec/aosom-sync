/**
 * upsertImportJob's ON CONFLICT(group_key) branch, exercised against the REAL schema in an
 * in-memory libsql database through the real exported function — not a copy of its SQL.
 *
 * Root cause (2026-10-02): Aosom's PSIN groups every BTU/capacity + colour combination of a
 * model under ONE group_key (823-058V81BK/WT [8,000 BTU] and 823-058V83BK/WT [10,000 BTU]
 * all share PSIN 256L5LETCAO00), but these combinations were historically imported to Shopify
 * as SEPARATE products. Queuing a never-imported combination whose group_key was previously
 * used by an already-imported sibling used to leave that sibling's shopify_id sitting on the
 * row — status reset to 'pending', but shopify_id still set — which made importToShopify's
 * idempotency guard (`if (row.shopify_id) return already_imported`) silently refuse to ever
 * create the new combination. See src/lib/database.ts's upsertImportJob doc comment.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

// Must be set before database.ts is imported: it caches its client on first use.
process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let upsertImportJob: typeof import("@/lib/database").upsertImportJob;

async function job(id: string) {
  const r = await db.execute({ sql: `SELECT * FROM import_jobs WHERE id = ?`, args: [id] });
  return r.rows[0] as unknown as { id: string; group_key: string; status: string; shopify_id: string | null; content: string | null; error: string | null };
}

beforeAll(async () => {
  const mod = await import("@/lib/database");
  db = await mod.ensureSchema();
  upsertImportJob = mod.upsertImportJob;
});

beforeEach(async () => {
  await db.execute(`DELETE FROM import_jobs`);
});

describe("upsertImportJob — ON CONFLICT(group_key)", () => {
  it("clears a stale shopify_id/content/error left by an already-imported sibling at the same PSIN group_key", async () => {
    const now = new Date().toISOString();

    // Simulate the 8,000 BTU combo (823-058V81xx) having been imported months ago: a row
    // at this group_key with shopify_id, content and error all populated.
    await db.execute({
      sql: `INSERT INTO import_jobs (id, group_key, product_data, status, content, shopify_id, error, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      args: ["old-job-id", "256L5LETCAO00", JSON.stringify({ sku: "823-058V81BK" }), JSON.stringify({ title: "old content" }), "9387257397353", "some old error", now, now],
    });

    // Now queue the never-imported 10,000 BTU combo (823-058V83xx) — same group_key.
    const returnedId = await upsertImportJob({
      id: "new-job-id",
      groupKey: "256L5LETCAO00",
      productData: JSON.stringify({ sku: "823-058V83BK" }),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    // ON CONFLICT keeps the PRE-EXISTING row's id (see the function's own doc comment).
    expect(returnedId).toBe("old-job-id");

    const row = await job("old-job-id");
    expect(row.status).toBe("pending");
    expect(row.shopify_id).toBeNull();
    expect(row.content).toBeNull();
    expect(row.error).toBeNull();
  });

  it("creates a fresh row with no conflict when the group_key is new", async () => {
    const now = new Date().toISOString();
    const id = await upsertImportJob({
      id: "brand-new",
      groupKey: "UNIQUE-GROUP-1",
      productData: JSON.stringify({ sku: "X" }),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    expect(id).toBe("brand-new");
    const row = await job("brand-new");
    expect(row.status).toBe("pending");
    expect(row.shopify_id).toBeNull();
  });
});
