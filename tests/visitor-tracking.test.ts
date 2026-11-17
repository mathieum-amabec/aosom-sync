import { describe, it, expect, beforeAll } from "vitest";
import { buildVisitorReport, deviceOf, isBotUserAgent, parseLanding, referrerHost, visitBucket } from "@/lib/visitor-tracking";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let database: typeof import("@/lib/database");
beforeAll(async () => {
  database = await import("@/lib/database");
  await database.ensureSchema();
});

describe("visitor-tracking helpers", () => {
  it("keeps the landing path without its query, and only the referrer host", () => {
    expect(parseLanding("https://www.furnishdirect.ca/products/x?utm_source=Facebook&fbclid=1&email=a@b.ca")).toEqual({ host: "furnishdirect.ca", path: "/products/x", utm: "facebook", fbclid: true });
    expect(parseLanding("nope")).toBeNull();
    expect(referrerHost("https://www.google.com/search?q=sofa")).toBe("google.com");
    expect(referrerHost("https://ameublodirect.ca/collections/x")).toBeNull();
    expect(referrerHost(42)).toBeNull();
  });
  it("classifies devices, bots and visit buckets", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("mobile");
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("tablet");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0)")).toBe("desktop");
    expect(isBotUserAgent("facebookexternalhit/1.1")).toBe(true);
    expect(isBotUserAgent(null)).toBe(true);
    expect([1, 2, 3, 5, 6, 40].map(visitBucket)).toEqual(["1", "2", "3-5", "3-5", "6+", "6+"]);
  });
});

describe("visitor_sessions", () => {
  it("stores one row per visit, flags ATC/checkout (even if the visit beacon was lost), and reports returns per site", async () => {
    const base = { pre: false, firstSeen: null, gapDays: null, landing: "/", referrer: null, utmSource: null, fbclid: false, country: "CA", device: "mobile" };
    await database.insertVisitorSession({ ...base, visitorHash: "a", visitN: 1, host: "ameublodirect.ca" });
    await database.insertVisitorSession({ ...base, visitorHash: "a", visitN: 1, host: "ameublodirect.ca" });
    await database.insertVisitorSession({ ...base, visitorHash: "a", visitN: 2, host: "ameublodirect.ca", gapDays: 3 });
    await database.markVisitorSession("a", 2, "atc", { country: "CA", device: "mobile" });
    await database.markVisitorSession("a", 2, "checkout", { country: "CA", device: "mobile" });
    await database.insertVisitorSession({ ...base, visitorHash: "b", visitN: 1, host: "ameublodirect.ca" });
    await database.insertVisitorSession({ ...base, visitorHash: "c", visitN: 1, host: "furnishdirect.ca", pre: true });
    await database.markVisitorSession("d", 4, "atc", { country: "US", device: "desktop" });

    const rows = await database.getVisitorSessions(0, "CA");
    expect(rows).toHaveLength(4);
    const all = await database.getVisitorSessions(0, null);
    expect(all.find((r) => r.visitor_hash === "d")).toMatchObject({ visit_n: 4, atc: 1, checkout: 0, host: null });

    const rep = buildVisitorReport(rows);
    const am = rep.sites.find((s) => s.site === "ameublodirect.ca")!;
    expect(am).toMatchObject({ visits: 3, visitors: 2, returningVisitors: 1, returningPct: 50, atcPct: 33.3, checkoutPct: 33.3 });
    expect(am.byVisit["1"]).toMatchObject({ visits: 2, atc: 0 });
    expect(am.byVisit["2"]).toMatchObject({ visits: 1, atc: 1, checkout: 1, atcPct: 100 });
    const fu = rep.sites.find((s) => s.site === "furnishdirect.ca")!;
    expect(fu.byVisit).toEqual({ inconnu: { visits: 1, atc: 0, checkout: 0, atcPct: 0, checkoutPct: 0 } });
    expect(rep.medianDaysBetweenVisits).toBe(3);
  });
});
