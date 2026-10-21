/**
 * The teaser + AI-usage SQL against the REAL schema in an in-memory libsql DB: one event per (feature, event, source,
 * visitor), funnel grouping, consent text stored, and the atomic daily reservation that parallel requests cannot beat.
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let database: typeof import("@/lib/database");

beforeAll(async () => {
  database = await import("@/lib/database");
  await database.ensureSchema();
});

describe("teaser_events / teaser_signups", () => {
  it("keeps one row per (feature, event, source, visitor) and groups the funnel by source", async () => {
    const base = { feature: "decorateur", handle: null, locale: "fr" };
    await database.insertTeaserEvent({ ...base, event: "click", source: "chat", visitorHash: "v1" });
    await database.insertTeaserEvent({ ...base, event: "click", source: "chat", visitorHash: "v1" });
    await database.insertTeaserEvent({ ...base, event: "click", source: "sheet", visitorHash: "v1" });
    await database.insertTeaserEvent({ ...base, event: "click", source: "chat", visitorHash: "v2" });
    await database.upsertTeaserSignup({ feature: "decorateur", emailKey: "a@b.ca", email: "a@b.ca", source: "chat", consentText: "v1 — x", locale: "fr", handle: null });
    await database.upsertTeaserSignup({ feature: "decorateur", emailKey: "a@b.ca", email: "a@b.ca", source: "sheet", consentText: "v1 — x", locale: "fr", handle: null });
    const s = await database.getTeaserStats(0);
    expect(s.events).toEqual([
      { feature: "decorateur", source: "chat", event: "click", visitors: 2 },
      { feature: "decorateur", source: "sheet", event: "click", visitors: 1 },
    ]);
    expect(s.signups).toEqual([{ feature: "decorateur", source: "chat", n: 1 }]);
    expect((await database.getTeaserStats(Math.floor(Date.now() / 1000) + 60)).events).toEqual([]);
  });
});

describe("reserveVisualiserUse", () => {
  it("never lets parallel requests past the daily cap, per kind and IP", async () => {
    const since = Math.floor(Date.now() / 1000) - 86_400;
    const ids = await Promise.all(Array.from({ length: 10 }, () => database.reserveVisualiserUse({ kind: "visualiser", ipHash: "ip1", handle: "x", cap: 3, sinceSec: since })));
    expect(ids.filter((x) => x != null)).toHaveLength(3);
    // Another kind and another IP have their own caps.
    expect(await database.reserveVisualiserUse({ kind: "decorateur", ipHash: "ip1", handle: null, cap: 5, sinceSec: since })).not.toBeNull();
    expect(await database.reserveVisualiserUse({ kind: "visualiser", ipHash: "ip2", handle: "x", cap: 3, sinceSec: since })).not.toBeNull();
    const id = ids.find((x) => x != null)!;
    await database.finishVisualiserUse(id, true);
    const db = await database.ensureSchema();
    expect(Number((await db.execute({ sql: "SELECT ok FROM visualiser_uses WHERE id = ?", args: [id] })).rows[0].ok)).toBe(1);
  });
});
