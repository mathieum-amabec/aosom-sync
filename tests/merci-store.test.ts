/** post_purchase_offers + merci_candidates against the REAL schema in an in-memory libsql database. */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let store: typeof import("@/lib/post-purchase/store");

beforeAll(async () => {
  const mod = await import("@/lib/database");
  db = await mod.ensureSchema();
  store = await import("@/lib/post-purchase/store");
});

beforeEach(async () => {
  await db.execute(`DELETE FROM post_purchase_offers`);
  await db.execute(`DELETE FROM merci_candidates`);
  await db.execute(`DELETE FROM settings WHERE key = 'merci_catalog_gen'`);
});

const cand = (id: string) => ({ variantId: id, productId: `p${id}`, sku: `S${id}`, source: (id === "3" ? "costway" : "aosom") as "aosom" | "costway", handle: `h${id}`, title: `T${id}`, type: "A > B", colour: id === "1" ? "Noir" : null, price: 50, compareAt: null, cost: 20, imageUrl: "https://x", pct: 10 });

describe("candidate catalogue", () => {
  it("readers only see the latest generation; older ones are dropped", async () => {
    expect(await store.loadCandidates()).toEqual([]);
    await store.replaceCandidates([cand("1"), cand("2")], 100);
    await store.replaceCandidates([cand("3")], 200);
    const rows = await store.loadCandidates();
    expect(rows.map((r) => r.variantId)).toEqual(["3"]);
    expect(rows[0]).toMatchObject({ sku: "S3", source: "costway" });
    const all = await db.execute(`SELECT COUNT(*) AS n FROM merci_candidates`);
    expect(Number(all.rows[0].n)).toBe(1);
  });
  it("catalogueColour reads the product's supplier colour", async () => {
    await store.replaceCandidates([cand("1")], 300);
    expect(await store.catalogueColour("p1")).toBe("Noir");
    expect(await store.catalogueColour("nope")).toBeNull();
  });
});

describe("post_purchase_offers", () => {
  it("one reservation per order; finish then read back", async () => {
    expect(await store.reserveOffer("o1", "c1", 1000)).toBe(true);
    expect(await store.reserveOffer("o1", "c2", 1001)).toBe(false);
    expect(await store.finishOffer("o1", "c1", { orderName: "#1", status: "ready", offers: [{ title: "t", imageUrl: "i", handle: "h", variantId: "1", price: 50, compareAt: null, discountedPrice: 45, pct: 10, why: "w", code: "MERCI-X", discountId: "d" }], expiresAt: 2800 })).toBe(true);
    const row = await store.getOfferRow("o1");
    expect(row).toMatchObject({ status: "ready", expires_at: 2800, order_name: "#1" });
    expect(row?.offers[0].code).toBe("MERCI-X");
  });
  it("a stale 'pending' row can be taken over, a fresh one cannot; release frees it", async () => {
    await store.reserveOffer("o2", "c1", 1000);
    expect(await store.takeStaleReservation("o2", "c2", 90, 1050)).toBe(false);
    expect(await store.takeStaleReservation("o2", "c2", 90, 1200)).toBe(true);
    await store.releaseOffer("o2", "c2");
    expect(await store.getOfferRow("o2")).toBeNull();
  });
  it("release never deletes a finished offer", async () => {
    await store.reserveOffer("o3", "c1", 1000);
    await store.finishOffer("o3", "c1", { orderName: null, status: "none", offers: [], expiresAt: null });
    await store.releaseOffer("o3", "c1");
    expect((await store.getOfferRow("o3"))?.status).toBe("none");
  });
  it("#8 a superseded request can neither finish (overwrite the expiry) nor release the new owner's row", async () => {
    await store.reserveOffer("o4", "old", 1000);
    expect(await store.takeStaleReservation("o4", "new", 90, 1200)).toBe(true);
    await store.releaseOffer("o4", "old");
    expect((await store.getOfferRow("o4"))?.status).toBe("pending");
    expect(await store.finishOffer("o4", "new", { orderName: "#4", status: "ready", offers: [], expiresAt: 3000 })).toBe(true);
    expect(await store.finishOffer("o4", "old", { orderName: "#4", status: "ready", offers: [], expiresAt: 9999 })).toBe(false);
    expect((await store.getOfferRow("o4"))?.expires_at).toBe(3000);
  });
});
