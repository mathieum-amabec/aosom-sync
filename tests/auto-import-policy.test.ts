import { describe, it, expect } from "vitest";
import {
  allowedSoFar,
  buildCandidates,
  emptyState,
  isSeasonal,
  parseMode,
  pickBatch,
  TOYS_DAILY_CAP,
  type Candidate,
  stripLicensedNames,
  stripLicensedFromContent,
} from "@/lib/auto-import/policy";
import type { AosomMergedProduct, AosomVariant } from "@/types/aosom";

const NOW = new Date("2026-10-08T12:00:00Z");
const SEC = Math.floor(NOW.getTime() / 1000);

function variant(sku: string, o: Partial<AosomVariant> = {}): AosomVariant {
  return {
    sku, price: 100, qty: 50, color: "", size: "", gtin: "", weight: 5, dimensions: { length: 1, width: 1, height: 1 },
    images: [], estimatedArrival: "", outOfStockExpected: "", packageNum: "", boxSize: "", boxWeight: "", ...o,
  };
}
function group(key: string, o: Partial<AosomMergedProduct> = {}, v: Partial<AosomVariant> = {}): AosomMergedProduct {
  return {
    groupKey: key, name: `Produit ${key}`, brand: "x", productType: "Home Furnishings > Living Room", category: "",
    description: "d", shortDescription: "", material: "", images: ["a", "b", "c", "d"], video: "", pdf: "",
    variants: [variant(`${key}-A`, v)], ...o,
  };
}
const ctx = (extra: Partial<Parameters<typeof buildCandidates>[1]> = {}) => ({
  importedSkus: new Set<string>(), firstSeen: new Map<string, number>(), jobs: new Map(), now: NOW, ...extra,
});

describe("buildCandidates", () => {
  it("keeps a healthy group and drops stock < 10, < 3 images, price < 30", () => {
    const out = buildCandidates(
      [group("ok"), group("lowstock", {}, { qty: 9 }), group("fewimg", { images: ["a", "b"] }), group("cheap", {}, { price: 29.99 })],
      ctx(),
    );
    expect(out.candidates.map((c) => c.groupKey)).toEqual(["ok"]);
  });

  it("accepts a group when ONE variant holds >= 10 units and imports the stocked variants", () => {
    const g = group("multi");
    g.variants = [variant("m-1", { qty: 12 }), variant("m-2", { qty: 3 }), variant("m-3", { qty: 0 })];
    const [c] = buildCandidates([g], ctx()).candidates;
    expect(c.skus).toEqual(["m-1", "m-2"]);
  });

  it("skips groups already on Shopify or with a blocking job, retries old errors after 24h", () => {
    const groups = [group("onshop"), group("done"), group("review"), group("freshErr"), group("oldErr")];
    const out = buildCandidates(groups, ctx({
      importedSkus: new Set(["onshop-A"]),
      jobs: new Map([
        ["done", { status: "done", updatedAt: NOW.toISOString() }],
        ["review", { status: "needs_review", updatedAt: NOW.toISOString() }],
        ["freshErr", { status: "error", updatedAt: new Date(NOW.getTime() - 2 * 3_600_000).toISOString() }],
        ["oldErr", { status: "error", updatedAt: new Date(NOW.getTime() - 30 * 3_600_000).toISOString() }],
      ]),
    }));
    expect(out.candidates.map((c) => c.groupKey)).toEqual(["oldErr"]);
  });

  it("excludes patio unless it is a winter item", () => {
    const out = buildCandidates(
      [
        group("sofa", { productType: "Patio & Garden > Outdoor Furniture", name: "Ensemble de patio rotin" }),
        group("heater", { productType: "Patio & Garden > Heaters", name: "Outdoor heater" }),
      ],
      ctx(),
    );
    expect(out.candidates.map((c) => c.groupKey)).toEqual(["heater"]);
  });

  it("stripLicensedNames removes the brand, its model code and the licence wording", () => {
    expect(stripLicensedNames("Voiture électrique Mercedes-Benz G63 pour enfants 12 V")).toBe("Voiture électrique pour enfants 12 V");
    expect(stripLicensedNames("Auto Kawasaki sous licence officielle, noir")).toContain("noir");
    expect(stripLicensedNames("<p>Moto Harley pour enfants.</p>")).toBe("<p>Moto pour enfants.</p>");
    expect(stripLicensedNames("Camion jouet sans marque")).toBe("Camion jouet sans marque");
  });

  it("stripLicensedNames covers more brands and never eats the voltage that follows", () => {
    expect(stripLicensedNames("Voiture Jeep 12 V pour enfants")).toBe("Voiture 12 V pour enfants");
    expect(stripLicensedNames("Moto Aprilia 6V pour enfants")).toBe("Moto 6V pour enfants");
    expect(stripLicensedNames("SUV Chevrolet Tahoe 24V avec télécommande")).toBe("SUV 24V avec télécommande");
    expect(stripLicensedNames("Auto Mercedes Benz pour enfants")).toBe("Auto pour enfants");
    expect(stripLicensedNames("Kart Volkswagen VW Beetle")).not.toMatch(/volkswagen|\bvw\b/i);
  });

  it("stripLicensedFromContent cleans titles, descriptions, handles and tags and reports what changed", () => {
    const content = {
      titleFr: "Voiture Mercedes-Benz pour enfants 12 V",
      titleEn: "Kids 12V Mercedes-Benz ride-on car",
      descriptionFr: "<p>Auto Mercedes-Benz fiable.</p>",
      descriptionEn: "<p>Reliable Mercedes-Benz car.</p>",
      urlHandleFr: "voiture-mercedes-benz-enfants",
      urlHandleEn: "kids-ride-on-car",
      tags: ["mercedes-benz", "jouets"],
    };
    const { content: out, changed } = stripLicensedFromContent(content);
    expect(JSON.stringify(out)).not.toMatch(/mercedes/i);
    expect(changed).toEqual(expect.arrayContaining(["titleFr", "titleEn", "descriptionFr", "descriptionEn", "urlHandleFr", "tags"]));
    expect(out.tags).toEqual(["jouets"]);
    expect(stripLicensedFromContent({ titleFr: "Table basse", tags: [] }).changed).toEqual([]);
  });

  it("keeps licensed brand groups as candidates (the name is stripped from the copy later) and still counts them", () => {
    const out = buildCandidates(
      [group("merc", { name: "4 in 1 Toddler Push Car Licensed Mercedes-Benz", productType: "Toys & Games" }), group("plain", { productType: "Toys & Games" })],
      ctx(),
    );
    expect(out.flaggedLicensed).toEqual(["merc"]);
    expect(out.candidates.map((c) => c.groupKey).sort()).toEqual(["merc", "plain"]);
  });

  it("sums the supplier demand over the group's SKUs", () => {
    const g = group("dem");
    g.variants = [variant("d-1", { qty: 20 }), variant("d-2", { qty: 15 })];
    const [c] = buildCandidates([g], ctx({ demand: new Map([["d-1", 30], ["d-2", 12]]) })).candidates;
    expect(c.demand).toBe(42);
  });

  it("keeps only big sellers: supplier demand >= 10, or a product type that already sells on our store", () => {
    const types = { "Home Furnishings > Living Room": "Home Furnishings > Living Room", kitchen: "Home Furnishings > Kitchen" };
    const out = buildCandidates(
      [group("hot"), group("cold"), group("proven", { productType: types.kitchen })],
      ctx({
        demand: new Map([["hot-A", 12], ["cold-A", 3], ["proven-A", 1]]),
        storeTypeSales: new Map([[types.kitchen, 4]]),
      }),
    );
    expect(out.candidates.map((c) => c.groupKey).sort()).toEqual(["hot", "proven"]);
    expect(out.rejected.lowDemand).toBe(1);
  });

  it("does not filter on demand when the history is missing (never stops every import)", () => {
    expect(buildCandidates([group("a")], ctx()).candidates).toHaveLength(1);
    expect(buildCandidates([group("a")], ctx({ demand: new Map() })).candidates).toHaveLength(1);
  });

  it("marks a group first seen in the last 14 days as a new arrival", () => {
    const out = buildCandidates(
      [group("fresh"), group("old")],
      ctx({ firstSeen: new Map([["fresh-A", SEC - 2 * 86400], ["old-A", SEC - 90 * 86400]]) }),
    );
    const by = Object.fromEntries(out.candidates.map((c) => [c.groupKey, c.isNew]));
    expect(by).toEqual({ fresh: true, old: false });
  });
});

function cand(key: string, top: string, o: Partial<Candidate> = {}): Candidate {
  return { groupKey: key, skus: [key], name: key, productType: top, top, minPrice: 100, totalQty: 100, imageCount: 4, isNew: false, seasonal: false, ...o };
}

describe("pickBatch", () => {
  it("takes new arrivals before anything else", () => {
    const picked = pickBatch([cand("toy1", "Toys & Games"), cand("new1", "Pet Supplies", { isNew: true })], emptyState("d"), 1, 100);
    expect(picked.map((c) => c.groupKey)).toEqual(["new1"]);
  });

  it("no longer puts toys first: they are a small share and stop at the toy cap", () => {
    const toys = Array.from({ length: 30 }, (_, i) => cand(`t${i}`, "Toys & Games"));
    const home = Array.from({ length: 30 }, (_, i) => cand(`h${i}`, "Home Furnishings"));
    const picked = pickBatch([...toys, ...home], emptyState("d"), 20, 100);
    expect(picked.filter((c) => c.top === "Home Furnishings").length).toBeGreaterThan(picked.filter((c) => c.top === "Toys & Games").length);
    const atCap = { ...emptyState("d"), toys: TOYS_DAILY_CAP, total: 40, byCat: { "Toys & Games": TOYS_DAILY_CAP, "Home Furnishings": 30 } };
    expect(pickBatch(toys, atCap, 3, 100)).toHaveLength(0);
  });

  it("takes the products that sell most at the supplier first inside a category", () => {
    const picked = pickBatch(
      [cand("slow", "Home Furnishings", { totalQty: 2000 }), cand("fast", "Home Furnishings", { totalQty: 50, demand: 120 })],
      emptyState("d"), 1, 100,
    );
    expect(picked[0].groupKey).toBe("fast");
  });

  it("splits the non-toy slots by share, largest deficit first", () => {
    const pool = [
      ...Array.from({ length: 20 }, (_, i) => cand(`home${i}`, "Home Furnishings")),
      ...Array.from({ length: 20 }, (_, i) => cand(`pet${i}`, "Pet Supplies")),
      ...Array.from({ length: 20 }, (_, i) => cand(`sp${i}`, "Sports & Recreation")),
    ];
    const picked = pickBatch(pool, emptyState("d"), 10, 100);
    const count = (p: string) => picked.filter((c) => c.groupKey.startsWith(p)).length;
    expect(picked).toHaveLength(10);
    expect(count("home")).toBeGreaterThan(count("sp"));
    expect(count("pet")).toBeGreaterThan(0);
  });

  it("never exceeds n or what is left of the daily cap", () => {
    const pool = Array.from({ length: 10 }, (_, i) => cand(`h${i}`, "Home Furnishings"));
    expect(pickBatch(pool, { ...emptyState("d"), total: 99 }, 5, 100)).toHaveLength(1);
    expect(pickBatch(pool, { ...emptyState("d"), total: 100 }, 5, 100)).toHaveLength(0);
  });

  it("prefers seasonal products inside a category", () => {
    const picked = pickBatch([cand("plain", "Home Furnishings", { totalQty: 2000 }), cand("tree", "Home Furnishings", { seasonal: true, totalQty: 10 })], emptyState("d"), 1, 100);
    expect(picked[0].groupKey).toBe("tree");
  });
});

describe("pacing and seasons", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 8, h, m));
  it("allows nothing before 07:00 UTC and the full cap from 21:00", () => {
    expect(allowedSoFar(at(6, 59), 100)).toBe(0);
    expect(allowedSoFar(at(21, 0), 100)).toBe(100);
    expect(allowedSoFar(at(23, 0), 100)).toBe(100);
  });
  it("is monotonic and roughly linear across the window", () => {
    const a = allowedSoFar(at(10), 100);
    const b = allowedSoFar(at(14), 100);
    const c = allowedSoFar(at(18), 100);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(b).toBeGreaterThan(40);
    expect(b).toBeLessThan(60);
  });
  it("detects Christmas and winter items in season only", () => {
    expect(isSeasonal("Sapin de Noel", "Home Furnishings", new Date("2026-10-20T00:00:00Z"))).toBe(true);
    expect(isSeasonal("Sapin de Noel", "Home Furnishings", new Date("2026-12-20T00:00:00Z"))).toBe(false);
    expect(isSeasonal("Snow sled", "Sports", new Date("2026-01-10T00:00:00Z"))).toBe(true);
    expect(isSeasonal("Snow sled", "Sports", new Date("2026-07-10T00:00:00Z"))).toBe(false);
  });
  it("parses the mode, defaulting to off", () => {
    expect(parseMode("live")).toBe("live");
    expect(parseMode("pilot")).toBe("pilot");
    expect(parseMode("dry")).toBe("dry");
    expect(parseMode("anything")).toBe("off");
    expect(parseMode(null)).toBe("off");
  });
});
