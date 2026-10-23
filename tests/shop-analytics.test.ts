import { describe, it, expect } from "vitest";
import {
  META_AD_LABEL,
  addDays,
  classifyOrderSource,
  funnelFrom,
  groupOrderSources,
  montrealDayRangeUtc,
  salesFrom,
} from "@/lib/shop-analytics";

const visit = (source: string | null, campaign: string | null = null, extra: Record<string, unknown> = {}) => ({
  lastVisit: { source, sourceType: null, referrerUrl: null, utmParameters: { source, medium: null, campaign }, ...extra },
});

describe("classifyOrderSource", () => {
  it("counts a numeric Meta campaign id as a Meta ad", () => {
    expect(classifyOrderSource(visit("facebook", "52598252103605"))).toBe(META_AD_LABEL);
  });
  it("counts our campaign tags as Meta ads", () => {
    expect(classifyOrderSource(visit("facebook", "advantage_prix_bas_2026_10"))).toBe(META_AD_LABEL);
    expect(classifyOrderSource(visit("facebook", "retargeting_chaud_2026_10"))).toBe(META_AD_LABEL);
  });
  it("does not match the word « meta » inside another domain", () => {
    expect(classifyOrderSource({ lastVisit: { source: "metacafe.com", referrerUrl: "https://metacafe.com/", utmParameters: { medium: "paid" } } })).toBe("Autre");
    expect(classifyOrderSource({ lastVisit: { source: "meta", utmParameters: { medium: "paid" } } })).toBe(META_AD_LABEL);
  });
  it("does not call a plain facebook.com click an ad", () => {
    expect(classifyOrderSource({ lastVisit: { source: "https://facebook.com", referrerUrl: "https://facebook.com/" } })).toBe("Facebook / Instagram (sans pub identifiée)");
  });
  it("recognises organic search, AI assistants and email", () => {
    expect(classifyOrderSource({ lastVisit: { source: "Google", sourceType: "SEO" } })).toBe("Recherche (Google, Bing…)");
    expect(classifyOrderSource({ lastVisit: { source: "chatgpt.com" } })).toBe("ChatGPT / IA");
    expect(classifyOrderSource({ lastVisit: { source: "android-app://com.google.android.gm/" } })).toBe("Courriel");
  });
  it("is LAST click: a direct return after an old Meta click is Direct, not a Meta ad", () => {
    expect(classifyOrderSource({ lastVisit: { source: "direct" }, firstVisit: { source: "facebook", utmParameters: { campaign: "52598252103605" } } })).toBe("Direct");
    expect(classifyOrderSource({ lastVisit: { source: "Google", sourceType: "SEO" }, firstVisit: { source: "facebook", utmParameters: { campaign: "52598252103605" } } })).toBe("Recherche (Google, Bing…)");
  });
  it("uses the first visit only when Shopify gives no last visit, then falls back to Direct", () => {
    expect(classifyOrderSource({ firstVisit: { source: "facebook", utmParameters: { campaign: "52598252103605" } } })).toBe(META_AD_LABEL);
    expect(classifyOrderSource({ lastVisit: { source: "direct" } })).toBe("Direct");
    expect(classifyOrderSource(null)).toBe("Direct");
    expect(classifyOrderSource({})).toBe("Direct");
  });
});

describe("groupOrderSources", () => {
  it("groups, sums and sorts by order count", () => {
    const out = groupOrderSources([
      { journey: visit("facebook", "52598252103605"), total: 100 },
      { journey: visit("facebook", "52598252103605"), total: 50 },
      { journey: { lastVisit: { source: "direct" } }, total: 80 },
    ]);
    expect(out).toEqual([
      { label: META_AD_LABEL, orders: 2, total: 150 },
      { label: "Direct", orders: 1, total: 80 },
    ]);
  });
});

describe("montrealDayRangeUtc", () => {
  it("is 04:00Z to 04:00Z during daylight time (EDT)", () => {
    expect(montrealDayRangeUtc("2026-10-21")).toEqual({ startIso: "2026-10-21T04:00:00.000Z", endIso: "2026-10-22T04:00:00.000Z" });
  });
  it("is 05:00Z to 05:00Z during standard time (EST)", () => {
    expect(montrealDayRangeUtc("2026-12-15")).toEqual({ startIso: "2026-12-15T05:00:00.000Z", endIso: "2026-12-16T05:00:00.000Z" });
  });
  it("handles the switch day: Nov 1 2026 is 25 h long (EDT to EST)", () => {
    expect(montrealDayRangeUtc("2026-11-01")).toEqual({ startIso: "2026-11-01T04:00:00.000Z", endIso: "2026-11-02T05:00:00.000Z" });
  });
});

describe("row mapping", () => {
  it("builds the funnel and a conversion rate, tolerating empty rows", () => {
    expect(funnelFrom({ sessions: "200", sessions_with_cart_additions: 8, sessions_that_reached_checkout: 4, sessions_that_completed_checkout: 1 })).toEqual({ sessions: 200, carts: 8, checkouts: 4, bought: 1, conversion: 0.005 });
    expect(funnelFrom(undefined)).toEqual({ sessions: 0, carts: 0, checkouts: 0, bought: 0, conversion: 0 });
  });
  it("computes the average order value only when there are orders", () => {
    expect(salesFrom({ orders: 2, total_sales: "300" })).toEqual({ orders: 2, total: 300, aov: 150 });
    expect(salesFrom({ orders: 0, total_sales: 0 })).toEqual({ orders: 0, total: 0, aov: null });
  });
  it("addDays crosses month boundaries", () => {
    expect(addDays("2026-11-01", -6)).toBe("2026-10-26");
  });
});
