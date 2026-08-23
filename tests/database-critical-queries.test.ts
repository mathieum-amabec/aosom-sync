/**
 * The three `database.ts` functions that sit on an unattended path and were named by no test.
 *
 * Coverage put database.ts at 19%, which reads worse than it is: 34 test files mock
 * `@/lib/database` and assert the contract at the call site, so most of these functions ARE
 * verified — what never runs is their SQL body. Tracing the 155 exports against the jobs,
 * crons and pipeline libraries found 68 on a critical path and only these three both live and
 * untouched by any test:
 *
 *   getStaleImportedProducts  → stale-catalog (drafts products)
 *   getPendingWaitlist        → job1-sync (emails shoppers)
 *   markWaitlistNotified      → job1-sync (stops re-emailing them)
 *
 * They are exercised against the REAL schema in an in-memory libsql database and through the
 * REAL exported functions — not a copy of their SQL pasted into the test. The existing DB
 * suites mirror the SQL instead, which cannot catch the query drifting away from the mirror.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

// Must be set before database.ts is imported: it caches its client on first use.
process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let getStaleImportedProducts: typeof import("@/lib/database").getStaleImportedProducts;
let getPendingWaitlist: typeof import("@/lib/database").getPendingWaitlist;
let markWaitlistNotified: typeof import("@/lib/database").markWaitlistNotified;

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** Insert a product row with only the columns these queries read. */
async function product(over: { sku: string; shopifyId?: string | null; qty?: number; daysSinceSeen?: number }) {
  await db.execute({
    sql: `INSERT INTO products (sku, name, price, qty, shopify_product_id, last_seen_at)
          VALUES (?, ?, 0, ?, ?, ?)`,
    args: [
      over.sku,
      `Produit ${over.sku}`,
      over.qty ?? 5,
      over.shopifyId === undefined ? "900" : over.shopifyId,
      now() - (over.daysSinceSeen ?? 0) * DAY,
    ],
  });
}

async function waitlistEntry(over: { email: string; sku: string; confirmed?: number; notifiedAt?: number | null }) {
  await db.execute({
    sql: `INSERT INTO back_in_stock_waitlist (email, sku, confirmed, notified_at) VALUES (?, ?, ?, ?)`,
    args: [over.email, over.sku, over.confirmed ?? 1, over.notifiedAt ?? null],
  });
}

async function waitlistRow(id: number) {
  const r = await db.execute({ sql: `SELECT notified_at FROM back_in_stock_waitlist WHERE id = ?`, args: [id] });
  return r.rows[0] as unknown as { notified_at: number | null };
}

beforeAll(async () => {
  const mod = await import("@/lib/database");
  db = await mod.ensureSchema();
  getStaleImportedProducts = mod.getStaleImportedProducts;
  getPendingWaitlist = mod.getPendingWaitlist;
  markWaitlistNotified = mod.markWaitlistNotified;
});

beforeEach(async () => {
  await db.execute(`DELETE FROM products`);
  await db.execute(`DELETE FROM back_in_stock_waitlist`);
});

describe("getStaleImportedProducts — feeds the cron that drafts discontinued products", () => {
  it("returns an imported, in-stock product last seen beyond the window", async () => {
    await product({ sku: "OLD", daysSinceSeen: 45 });

    const stale = await getStaleImportedProducts(30);

    expect(stale).toEqual([{ sku: "OLD", shopify_product_id: "900" }]);
  });

  it("leaves a product still present in the feed alone", async () => {
    await product({ sku: "FRESH", daysSinceSeen: 2 });

    expect(await getStaleImportedProducts(30)).toEqual([]);
  });

  it("ignores a product that was never imported to Shopify", async () => {
    // Nothing to draft: the cron acts on Shopify, and this product isn't there.
    await product({ sku: "NOT-IMPORTED", shopifyId: null, daysSinceSeen: 45 });

    expect(await getStaleImportedProducts(30)).toEqual([]);
  });

  it("ignores a product already showing zero stock", async () => {
    // The risk this query exists for is overselling — a sold-out product cannot oversell.
    await product({ sku: "SOLD-OUT", qty: 0, daysSinceSeen: 45 });

    expect(await getStaleImportedProducts(30)).toEqual([]);
  });

  it("honours the window argument rather than a fixed 30 days", async () => {
    await product({ sku: "P40", daysSinceSeen: 40 });

    expect(await getStaleImportedProducts(30)).toHaveLength(1);
    expect(await getStaleImportedProducts(60)).toHaveLength(0);
  });

  it("puts the longest-unseen product first, so a capped run drafts the worst offenders", async () => {
    await product({ sku: "P35", daysSinceSeen: 35 });
    await product({ sku: "P90", daysSinceSeen: 90 });
    await product({ sku: "P60", daysSinceSeen: 60 });

    expect((await getStaleImportedProducts(30)).map((p) => p.sku)).toEqual(["P90", "P60", "P35"]);
  });

  it("round-trips a text-stored Shopify id unchanged", async () => {
    await product({ sku: "TXT", shopifyId: "123456789", daysSinceSeen: 45 });

    expect((await getStaleImportedProducts(30))[0].shopify_product_id).toBe("123456789");
  });

  it("documents why the id must be bound as text: a numeric bind comes back as 123456789.0", async () => {
    // SQLite's TEXT affinity turns a numerically-bound value into "123456789.0", which would
    // never match a Shopify id. Every writer types the parameter as `string`, so this cannot
    // happen today — this test exists to fail loudly if that type is ever widened.
    await db.execute({
      sql: `INSERT INTO products (sku, name, price, qty, shopify_product_id, last_seen_at) VALUES (?, ?, 0, 5, ?, ?)`,
      args: ["NUM", "Produit", 123456789, now() - 45 * DAY],
    });

    expect((await getStaleImportedProducts(30))[0].shopify_product_id).toBe("123456789.0");
  });
});

describe("getPendingWaitlist — decides who gets a back-in-stock email", () => {
  it("returns confirmed, un-notified subscribers for the SKU", async () => {
    await waitlistEntry({ email: "a@test.ca", sku: "SKU-1" });

    expect(await getPendingWaitlist("SKU-1")).toEqual([{ id: expect.any(Number), email: "a@test.ca" }]);
  });

  it("never emails an unconfirmed address", async () => {
    // Double opt-in: an unconfirmed row is someone else's address typed into our form.
    await waitlistEntry({ email: "unconfirmed@test.ca", sku: "SKU-1", confirmed: 0 });

    expect(await getPendingWaitlist("SKU-1")).toEqual([]);
  });

  it("never emails someone twice", async () => {
    await waitlistEntry({ email: "done@test.ca", sku: "SKU-1", notifiedAt: now() - 3600 });

    expect(await getPendingWaitlist("SKU-1")).toEqual([]);
  });

  it("does not leak subscribers of another SKU", async () => {
    await waitlistEntry({ email: "other@test.ca", sku: "SKU-2" });

    expect(await getPendingWaitlist("SKU-1")).toEqual([]);
  });

  it("returns every pending subscriber, not just the first", async () => {
    await waitlistEntry({ email: "a@test.ca", sku: "SKU-1" });
    await waitlistEntry({ email: "b@test.ca", sku: "SKU-1" });

    expect((await getPendingWaitlist("SKU-1")).map((w) => w.email).sort()).toEqual(["a@test.ca", "b@test.ca"]);
  });
});

describe("markWaitlistNotified — stops the re-send", () => {
  it("stamps the given ids and leaves the others pending", async () => {
    await waitlistEntry({ email: "a@test.ca", sku: "SKU-1" });
    await waitlistEntry({ email: "b@test.ca", sku: "SKU-1" });
    const [a, b] = await getPendingWaitlist("SKU-1");

    await markWaitlistNotified([a.id]);

    expect((await waitlistRow(a.id)).notified_at).toBeTypeOf("number");
    expect((await waitlistRow(b.id)).notified_at).toBeNull();
    expect((await getPendingWaitlist("SKU-1")).map((w) => w.id)).toEqual([b.id]);
  });

  it("stamps several ids in one call", async () => {
    await waitlistEntry({ email: "a@test.ca", sku: "SKU-1" });
    await waitlistEntry({ email: "b@test.ca", sku: "SKU-1" });
    const ids = (await getPendingWaitlist("SKU-1")).map((w) => w.id);

    await markWaitlistNotified(ids);

    expect(await getPendingWaitlist("SKU-1")).toEqual([]);
  });

  it("issues no query at all for an empty list", async () => {
    // Asserting "nothing changed" is not enough: without the guard the SQL degrades to
    // `IN ()`, which SQLite happily accepts and matches nothing — so the observable state
    // would be identical. The guard's actual job is to skip the round-trip entirely (and
    // `IN ()` is not valid standard SQL, so a remote engine may well reject it).
    await waitlistEntry({ email: "a@test.ca", sku: "SKU-1" });

    const real = db.execute.bind(db);
    let queries = 0;
    db.execute = ((...args: Parameters<typeof real>) => {
      queries++;
      return real(...args);
    }) as typeof db.execute;

    try {
      await expect(markWaitlistNotified([])).resolves.toBeUndefined();
      expect(queries).toBe(0);
    } finally {
      db.execute = real;
    }

    expect(await getPendingWaitlist("SKU-1")).toHaveLength(1);
  });

  it("is idempotent — re-stamping an already-notified row is harmless", async () => {
    await waitlistEntry({ email: "a@test.ca", sku: "SKU-1" });
    const [a] = await getPendingWaitlist("SKU-1");

    await markWaitlistNotified([a.id]);
    await expect(markWaitlistNotified([a.id])).resolves.toBeUndefined();

    expect(await getPendingWaitlist("SKU-1")).toEqual([]);
  });
});
