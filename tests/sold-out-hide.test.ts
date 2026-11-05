import { describe, it, expect, vi } from "vitest";
import {
  aosomAvailability,
  assertHidePlausible,
  costwayAvailability,
  isHalloweenProductType,
  isInSeason,
  parseHideMode,
  parseSeasonWindows,
  planSoldOutHide,
  seasonalRules,
  SEASON_TAG,
  type HideCandidateProduct,
} from "@/lib/sold-out-hide";
import { runSoldOutHide, type SoldOutHideDeps } from "@/lib/sold-out-hide-run";

const HALLOWEEN = "Home Furnishings > Holiday & Seasonal > Halloween Decorations";
const CHAIR = "Home Furnishings > Furniture > Chairs";
// Store-local dates (America/Toronto). Nov 4 = out of Halloween season, Sep 15 = in season.
const NOV = new Date("2026-11-04T15:00:00Z");
const SEP = new Date("2026-09-15T15:00:00Z");

const prod = (o: Partial<HideCandidateProduct> & { id: string }): HideCandidateProduct => ({
  shopifyProductId: o.id,
  title: o.title ?? `P ${o.id}`,
  handle: o.handle ?? `p-${o.id}`,
  status: o.status ?? "active",
  tags: o.tags ?? [],
  productType: o.productType ?? CHAIR,
  skus: o.skus ?? [`${o.id}-A`],
  source: o.source ?? "aosom",
  availability: o.availability ?? { present: true, sellable: true },
});
const plan = (products: HideCandidateProduct[], now = NOV, openOrders: string[] = []) =>
  planSoldOutHide({ products, openOrderProductIds: new Set(openOrders), rules: seasonalRules(), now });

describe("seasonal rule", () => {
  it("matches the product_type word Halloween in both taxonomy forms, not a Halloween TAG", () => {
    expect(isHalloweenProductType(HALLOWEEN)).toBe(true);
    expect(isHalloweenProductType("Holiday & Seasonal > Halloween Decorations")).toBe(true);
    expect(isHalloweenProductType("Holiday & Seasonal > Christmas Trees > Pencil Christmas Trees")).toBe(false);
    // A Christmas tree tagged « Halloween » exists on this store: tags must never decide.
    const p = plan([prod({ id: "XMAS", productType: "Holiday & Seasonal > Christmas Trees", tags: ["Halloween"] })]);
    expect(p.actions).toEqual([]);
  });

  it("window: Sep 1 inclusive → Nov 1 exclusive, store-local", () => {
    const w = { start: "09-01", end: "11-01" };
    expect(isInSeason(w, new Date("2026-09-01T05:00:00Z"))).toBe(true); // 01:00 Toronto, Sep 1
    expect(isInSeason(w, new Date("2026-09-01T03:00:00Z"))).toBe(false); // still Aug 31 in Toronto
    expect(isInSeason(w, new Date("2026-10-31T23:00:00Z"))).toBe(true); // 19:00 Oct 31
    expect(isInSeason(w, new Date("2026-11-01T05:00:00Z"))).toBe(false);
    expect(isInSeason({ start: "11-15", end: "01-05" }, new Date("2026-12-30T15:00:00Z"))).toBe(true); // wraps
  });

  it("settings override is validated, malformed falls back to the default", () => {
    expect(parseSeasonWindows('{"halloween":{"start":"08-15","end":"11-02"}}').halloween).toEqual({ start: "08-15", end: "11-02" });
    expect(parseSeasonWindows('{"halloween":{"start":"8-15","end":"x"}}').halloween).toEqual({ start: "09-01", end: "11-01" });
    expect(parseSeasonWindows("not json").halloween.start).toBe("09-01");
  });
});

describe("availability", () => {
  it("Aosom uses the buffered rule (qty > 10) on today's CSV; absent SKUs count for nothing", () => {
    const csv = new Map([["A", 10], ["B", 11]]);
    expect(aosomAvailability(["A"], csv)).toEqual({ present: true, sellable: false });
    expect(aosomAvailability(["A", "B"], csv)).toEqual({ present: true, sellable: true });
    expect(aosomAvailability(["Z"], csv)).toEqual({ present: false, sellable: false });
  });
  it("Costway needs in_stock AND at least 3 units", () => {
    expect(costwayAvailability([{ inStock: true, qty: 2 }]).sellable).toBe(false);
    expect(costwayAvailability([{ inStock: false, qty: 40 }]).sellable).toBe(false);
    expect(costwayAvailability([{ inStock: true, qty: 3 }]).sellable).toBe(true);
  });
});

describe("planSoldOutHide — hiding", () => {
  it("drafts an active product whose every variant is sold out, with auto-drafted + out-of-stock", () => {
    const p = plan([prod({ id: "1", tags: ["back-in-stock", "Chaise"], availability: { present: true, sellable: false } })]);
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ action: "hide_sold_out", targetStatus: "draft" });
    expect(p.actions[0].tags).toEqual(["Chaise", "out-of-stock", "auto-drafted"]);
  });

  it("leaves a product with at least one sellable variant alone", () => {
    expect(plan([prod({ id: "1", availability: { present: true, sellable: true } })]).actions).toEqual([]);
  });

  it("never drafts a product entirely absent from the feed (rename guard belongs to removed-catalog)", () => {
    const p = plan([prod({ id: "1", availability: { present: false, sellable: false } })]);
    expect(p.actions).toEqual([]);
    expect(p.counts.skippedAbsentFromFeed).toBe(1);
  });

  it("never touches a product in an open order, nor an exclude-stale one", () => {
    const so = { present: true, sellable: false };
    const p = plan([prod({ id: "1", availability: so }), prod({ id: "2", availability: so, tags: ["exclude-stale"] })], NOV, ["1"]);
    expect(p.actions).toEqual([]);
    expect(p.counts.skippedOpenOrder).toBe(1);
    expect(p.counts.skippedExcludeStale).toBe(1);
  });

  it("drafts an IN-STOCK Halloween product out of season, with hors-saison and WITHOUT auto-drafted", () => {
    const p = plan([prod({ id: "H", productType: HALLOWEEN, tags: ["Halloween", "auto-drafted"] })]);
    expect(p.actions[0]).toMatchObject({ action: "hide_season", targetStatus: "draft" });
    expect(p.actions[0].tags).toEqual(["Halloween", SEASON_TAG]);
  });

  it("keeps an in-stock Halloween product live during the season", () => {
    expect(plan([prod({ id: "H", productType: HALLOWEEN })], SEP).actions).toEqual([]);
  });
});

describe("planSoldOutHide — drafts and coming back", () => {
  it("reactivates an auto-drafted product that is sellable again", () => {
    const p = plan([prod({ id: "1", status: "draft", tags: ["auto-drafted", "out-of-stock"] })]);
    expect(p.actions[0]).toMatchObject({ action: "reactivate", targetStatus: "active" });
    expect(p.actions[0].tags).toEqual(["back-in-stock"]);
  });

  it("never reactivates a draft it does not own (no marker) or one still sold out", () => {
    const p = plan([
      prod({ id: "1", status: "draft", tags: [] }),
      prod({ id: "2", status: "draft", tags: ["auto-drafted"], availability: { present: true, sellable: false } }),
      prod({ id: "3", status: "draft", tags: ["auto-drafted", "exclude-stale"] }),
    ]);
    expect(p.actions).toEqual([]);
  });

  it("NEVER marks an operator's Halloween draft (no auto-drafted): it must not come back at a season start", () => {
    const p = plan([prod({ id: "H", status: "draft", productType: HALLOWEEN, tags: ["Halloween"], availability: { present: false, sellable: false } })]);
    expect(p.actions).toEqual([]);
    // …and at the season start it is still left alone, even in stock.
    expect(plan([prod({ id: "H", status: "draft", productType: HALLOWEEN, tags: ["Halloween"] })], SEP).actions).toEqual([]);
  });

  it("the full cycle: an active in-stock Halloween product it drafts in November comes back in September", () => {
    const hidden = plan([prod({ id: "H", productType: HALLOWEEN, tags: ["Halloween"] })]).actions[0];
    expect(hidden.action).toBe("hide_season");
    const back = plan([prod({ id: "H", status: "draft", productType: HALLOWEEN, tags: hidden.tags })], SEP).actions[0];
    expect(back).toMatchObject({ action: "reactivate", targetStatus: "active", tags: ["Halloween", "back-in-stock"] });
  });

  it("does not mark an import held for review", () => {
    expect(plan([prod({ id: "H", status: "draft", productType: HALLOWEEN, tags: ["needs-review"] })]).actions).toEqual([]);
  });

  it("an out-of-season auto-drafted Halloween draft is re-marked, never reactivated", () => {
    const p = plan([prod({ id: "H", status: "draft", productType: HALLOWEEN, tags: ["auto-drafted"] })]);
    expect(p.actions[0].action).toBe("mark_season");
    expect(p.actions[0].tags).toEqual([SEASON_TAG]);
  });

  it("at season start: in stock → reactivated; sold out → handed to auto-drafted", () => {
    const p = plan([
      prod({ id: "A", status: "draft", productType: HALLOWEEN, tags: [SEASON_TAG] }),
      prod({ id: "B", status: "draft", productType: HALLOWEEN, tags: [SEASON_TAG], availability: { present: true, sellable: false } }),
    ], SEP);
    const by = Object.fromEntries(p.actions.map((a) => [a.shopifyProductId, a]));
    expect(by.A).toMatchObject({ action: "reactivate", targetStatus: "active", tags: ["back-in-stock"] });
    expect(by.B).toMatchObject({ action: "release_season", targetStatus: "draft", tags: ["auto-drafted"] });
  });

  it("an hors-saison draft stays put while still out of season", () => {
    expect(plan([prod({ id: "A", status: "draft", productType: HALLOWEEN, tags: [SEASON_TAG] })]).actions).toEqual([]);
  });

  it("orders hides before reactivations", () => {
    const p = plan([
      prod({ id: "1", status: "draft", tags: ["auto-drafted"] }),
      prod({ id: "2", availability: { present: true, sellable: false } }),
    ]);
    expect(p.actions.map((a) => a.action)).toEqual(["hide_sold_out", "reactivate"]);
  });
});

describe("guards", () => {
  it("mass-hide circuit breaker", () => {
    const many = Array.from({ length: 250 }, (_, i) => prod({ id: String(i), availability: { present: true, sellable: false } }));
    expect(() => assertHidePlausible(plan(many))).toThrow(/stock source looks broken/);
    expect(() => assertHidePlausible(plan(many.slice(0, 150)))).not.toThrow();
  });
  it("mode defaults to live, unknown values too", () => {
    expect(parseHideMode(null)).toBe("live");
    expect(parseHideMode("dry")).toBe("dry");
    expect(parseHideMode("nope")).toBe("live");
  });
});

describe("runSoldOutHide", () => {
  const baseDeps = (over: Partial<SoldOutHideDeps> = {}): Partial<SoldOutHideDeps> => {
    const live = new Map<string, { status: "active" | "draft" | "archived"; tags: string[] }>([
      ["SO", { status: "active", tags: [] }],
      ["OK", { status: "active", tags: [] }],
      ["H", { status: "active", tags: [] }],
      ["BACK", { status: "draft", tags: ["auto-drafted"] }],
    ]);
    return {
      now: () => NOV,
      getSetting: async () => null,
      fetchAosomCsvQty: async () => new Map([["SO-A", 0], ["OK-A", 50], ["H-A", 50], ["BACK-A", 40]]),
      getAosomBaseline: async () => ["SO", "OK", "H", "BACK"].map((id) => ({ sku: `${id}-A`, shopifyProductId: id, qty: 0, lastSeenAt: 0 })),
      getCostwayStock: async () => [],
      fetchProducts: async () => [
        { shopifyId: "SO", status: "active", tags: [], productType: CHAIR, title: "so", handle: "so" },
        { shopifyId: "OK", status: "active", tags: [], productType: CHAIR, title: "ok", handle: "ok" },
        { shopifyId: "H", status: "active", tags: [], productType: HALLOWEEN, title: "h", handle: "h" },
        { shopifyId: "BACK", status: "draft", tags: ["auto-drafted"], productType: CHAIR, title: "b", handle: "b" },
      ],
      fetchOpenOrderProductIds: async () => new Set(),
      getState: async (id) => live.get(id) ?? null,
      setDraft: vi.fn(async () => {}),
      setActive: vi.fn(async () => {}),
      setTags: vi.fn(async () => {}),
      sleep: async () => {},
      ...over,
    };
  };

  it("dry mode plans everything and writes nothing", async () => {
    const deps = baseDeps();
    const r = await runSoldOutHide({ mode: "dry" }, deps);
    expect(r.actions.map((a) => `${a.action}:${a.shopifyProductId}`).sort()).toEqual(["hide_season:H", "hide_sold_out:SO", "reactivate:BACK"]);
    expect(deps.setDraft).not.toHaveBeenCalled();
    expect(deps.setActive).not.toHaveBeenCalled();
  });

  it("live mode drafts, reactivates (publish) and respects the cap", async () => {
    const deps = baseDeps();
    const r = await runSoldOutHide({ mode: "live" }, deps);
    expect(r.applied).toBe(3);
    expect(deps.setDraft).toHaveBeenCalledWith("SO", ["out-of-stock", "auto-drafted"]);
    expect(deps.setDraft).toHaveBeenCalledWith("H", [SEASON_TAG]);
    expect(deps.setActive).toHaveBeenCalledWith("BACK", ["back-in-stock"]);

    const capped = await runSoldOutHide({ mode: "live", maxWrites: 1 }, baseDeps());
    expect(capped.applied).toBe(1);
    expect(capped.deferred).toBe(2);
  });

  it("re-reads each product: one changed in the admin since the plan is skipped", async () => {
    const deps = baseDeps({ getState: async (id) => (id === "SO" ? { status: "draft", tags: [] } : { status: "active", tags: [] }) });
    const r = await runSoldOutHide({ mode: "live" }, deps);
    expect(deps.setDraft).not.toHaveBeenCalledWith("SO", expect.anything());
    expect(r.skippedChanged).toBeGreaterThanOrEqual(1);
  });

  it("off mode does nothing; a truncated feed aborts before any write", async () => {
    expect((await runSoldOutHide({ mode: "off" }, baseDeps())).actions).toEqual([]);
    const deps = baseDeps({ fetchAosomCsvQty: async () => new Map() });
    await expect(runSoldOutHide({ mode: "live" }, deps)).rejects.toThrow(/truncated/);
    expect(deps.setDraft).not.toHaveBeenCalled();
  });

  it("an open-orders failure aborts the run (fail closed)", async () => {
    const deps = baseDeps({ fetchOpenOrderProductIds: async () => { throw new Error("403"); } });
    await expect(runSoldOutHide({ mode: "live" }, deps)).rejects.toThrow("403");
  });
});
