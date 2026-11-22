import { describe, it, expect } from "vitest";
import {
  normalizeType,
  leafHead,
  ruleFor,
  outOfSeason,
  isAppliance,
  choosePair,
  COMPLEMENT_MAP,
  colourFamily,
  discountTier,
  priceCap,
  pickOffers,
  type MerciCandidate,
  type OrderLineInput,
} from "@/lib/post-purchase/offer-rules";

const L = "Home Furnishings > Living Room Furniture";
const NOV = new Date("2026-11-21T15:00:00Z");
const JUL = new Date("2026-07-10T15:00:00Z");

let n = 0;
function cand(over: Partial<MerciCandidate>): MerciCandidate {
  n++;
  return {
    variantId: String(1000 + n),
    productId: String(500 + n),
    sku: `SKU-${n}`,
    source: "aosom",
    handle: `p-${n}`,
    title: `Produit ${n}`,
    type: `${L} > Side Tables`,
    colour: null,
    price: 60,
    compareAt: null,
    cost: 30,
    imageUrl: "https://cdn.shopify.com/x.jpg",
    pct: 10,
    ...over,
  };
}

const sofa: OrderLineInput = { productId: "1", productType: `Home Furnishings > Living Room Furniture > Sofas & Reclining Chairs > Single Sofas`, title: "Fauteuil d'accent", variantTitle: "Noir", price: 240.88 };

describe("normalizeType / leafHead", () => {
  it("strips NBSP and collapses spaces in every segment", () => {
    expect(normalizeType("Pet Supplies > Cats > Cat Litter  Box Enclosures ")).toBe("Pet Supplies > Cats > Cat Litter Box Enclosures");
  });
  it("finds the leaf head noun", () => {
    expect(leafHead(`${L} > Side Tables`)).toBe("table");
    expect(leafHead(`${L} > Coffee Tables`)).toBe("table");
    expect(leafHead("Holiday & Seasonal > Christmas Trees")).toBe("tree");
  });
});

describe("map, season, appliances, colour", () => {
  it("routes an armchair to living-room complements and a buffet to kitchen ones", () => {
    expect(ruleFor(sofa.productType)?.targets[0]).toBe(`${L} > Side Tables`);
    expect(ruleFor("Home Furnishings > Kitchen & Dining Furniture > Buffets")?.noun).toBe("cuisine");
    expect(ruleFor("Toys & Games > Something Unknown")).toBeNull();
  });
  it("Christmas only Nov–Dec, Halloween only Sep–Oct, summer patio blocked Oct–Mar", () => {
    expect(outOfSeason("Holiday & Seasonal > Christmas Trees", 11)).toBe(false);
    expect(outOfSeason("Holiday & Seasonal > Christmas Trees", 7)).toBe(true);
    expect(outOfSeason("Holiday & Seasonal > Halloween", 10)).toBe(false);
    expect(outOfSeason("Holiday & Seasonal > Halloween", 11)).toBe(true);
    expect(outOfSeason("Patio & Garden > Patio Umbrellas", 11)).toBe(true);
    expect(outOfSeason("Patio & Garden > Patio Umbrellas", 6)).toBe(false);
    expect(outOfSeason("Patio & Garden > Patio Furniture Covers", 1)).toBe(false);
  });
  it("never offers appliances", () => {
    expect(isAppliance("Home Furnishings > Appliances > Mini Fridges", "Mini frigo")).toBe(true);
    expect(isAppliance(`${L} > Side Tables`, "Réfrigérateur compact")).toBe(true);
    expect(isAppliance(`${L} > Side Tables`, "Table d'appoint")).toBe(false);
  });
  it("colour families (EN and FR)", () => {
    expect(colourFamily("Black")).toBe("dark");
    expect(colourFamily("Noir")).toBe("dark");
    expect(colourFamily("Chêne naturel")).toBe("wood");
    expect(colourFamily("Gris")).toBe("grey");
    expect(colourFamily("")).toBeNull();
  });
});

describe("discountTier — keep ≥ max(8 $, 8 %) after the discount and card fees", () => {
  it("10 % when the margin allows it", () => {
    // 65.88 cat tree, cost ~ 38: 59.29 paid → keeps ~19 $
    expect(discountTier(65.88, 38)).toBe(10);
  });
  it("5 % when 10 % is too much but 5 % keeps the floor", () => {
    // 100 $ at cost 81: −10 % keeps 6.09 $ (< 8 $), −5 % keeps 10.94 $
    expect(discountTier(100, 81)).toBe(5);
  });
  it("0 for thin-margin deep-discount items (Aosom 1.17 × cost)", () => {
    expect(discountTier(110.88, 94.77)).toBe(0);
  });
  it("0 when the cost is unknown", () => {
    expect(discountTier(60, null)).toBe(0);
    expect(discountTier(60, 0)).toBe(0);
  });
});

describe("priceCap", () => {
  it("is max(50 %, 50 $) and never above the anchor", () => {
    expect(priceCap(300)).toBe(150);
    expect(priceCap(80)).toBe(50);
    expect(priceCap(40)).toBe(40);
  });
});

describe("pickOffers", () => {
  it("picks a side table for an armchair, plus an alternative of another type", () => {
    const side = cand({ title: "Table d'appoint ronde", price: 53.99, colour: "Black" });
    const tray = cand({ title: "Plateau d'accoudoir", type: L, price: 39.99 });
    const res = pickOffers([sofa], [tray, side], { now: NOV });
    expect(res.picks.map((p) => p.title)).toEqual(["Table d'appoint ronde", "Plateau d'accoudoir"]);
    expect(res.picks[0].why).toBe("Pour aller avec votre nouveau salon");
    expect(res.picks[0].discountedPrice).toBe(48.6); // 53.99 − 5.39 (rounded down): exactly what checkout charges
  });

  it("never proposes the same product type as anything in the order (no 2nd sofa / 2nd table)", () => {
    const coffee: OrderLineInput = { productId: "9", productType: `${L} > Coffee Tables`, title: "Table basse", price: 205.88 };
    const otherCoffee = cand({ type: `${L} > Coffee Tables`, price: 80 });
    const sideTable = cand({ type: `${L} > Side Tables`, price: 70 }); // head noun "table" = same kind
    const lamp = cand({ type: "Home Furnishings > Lighting > Floor Lamps", price: 79.99 });
    const res = pickOffers([coffee], [otherCoffee, sideTable, lamp], { now: NOV });
    expect(res.picks.map((p) => p.type)).toEqual(["Home Furnishings > Lighting > Floor Lamps"]);
  });

  it("respects the price cap and the 15 $ minimum", () => {
    const tooBig = cand({ price: 200 });
    const tooSmall = cand({ price: 9.99 });
    expect(pickOffers([sofa], [tooBig, tooSmall], { now: NOV }).picks).toEqual([]);
  });

  it("skips candidates without a discount tier, already in the order, or out of season", () => {
    const noTier = cand({ pct: 0 });
    const inOrder = cand({ productId: "1" });
    const tree: OrderLineInput = { productId: "7", productType: "Holiday & Seasonal > Christmas Trees", title: "Sapin", price: 127.88 };
    const deco = cand({ type: "Holiday & Seasonal > Christmas Decorations", title: "Renne lumineux", price: 51.99 });
    expect(pickOffers([sofa], [noTier, inOrder], { now: NOV }).picks).toEqual([]);
    expect(pickOffers([tree], [deco], { now: NOV }).picks).toHaveLength(1);
    expect(pickOffers([tree], [deco], { now: JUL }).picks).toHaveLength(0);
  });

  it("prefers the matching colour family", () => {
    const grey = cand({ title: "Grise", price: 72, colour: "Grey" });
    const black = cand({ title: "Noire", price: 72, colour: "Noir" });
    expect(pickOffers([sofa], [grey, black], { now: NOV, anchorColour: "Black" }).picks[0].title).toBe("Noire");
  });

  it("uses the most expensive line as the anchor and keeps one variant per product", () => {
    const cheap: OrderLineInput = { productId: "2", productType: "Pet Supplies > Cats > Cat Litter Box Enclosures", title: "Litière", price: 48 };
    const a = cand({ productId: "77", price: 60 });
    const b = cand({ productId: "77", variantId: "9999", price: 65 });
    const res = pickOffers([cheap, sofa], [a, b], { now: NOV });
    expect(res.anchor?.title).toBe("Fauteuil d'accent");
    expect(res.picks).toHaveLength(1);
  });

  it("returns nothing for an unknown category or an empty order", () => {
    expect(pickOffers([{ productId: "3", productType: "Toys & Games > Unknown", title: "X", price: 100 }], [cand({})], { now: NOV }).picks).toEqual([]);
    expect(pickOffers([], [cand({})], { now: NOV }).anchor).toBeNull();
  });

  it("no kids' items unless the anchor is a kids' item", () => {
    const kids = cand({ title: "Bibliothèque pour enfant", type: "Home Furnishings > Living Room Furniture > Side Tables" });
    expect(pickOffers([sofa], [kids], { now: NOV }).picks).toEqual([]);
  });
});

describe("review fixes 2026-11-21", () => {
  const TREE = "Holiday Decor > Christmas Decorations > Christmas Trees";
  const tree: OrderLineInput = { productId: "1", productType: TREE, title: "Sapin 7 pi", price: 200 };

  it("#1 a title target never lifts the same-type / same-kind guards (no 2nd tree « avec guirlande »)", () => {
    const secondTree = cand({ title: "Sapin pré-illuminé avec guirlande", type: TREE, price: 90 });
    const otherTreeType = cand({ title: "Sapin crayon avec guirlande", type: "Holiday Decor > Christmas Trees > Pencil Christmas Trees", price: 80 });
    const wreath = cand({ title: "Couronne", type: "Holiday Decor > Christmas Decorations > Wreaths", price: 60 });
    const res = pickOffers([tree], [secondTree, otherTreeType, wreath], { now: NOV });
    expect(res.picks.map((p) => p.title)).toEqual(["Couronne"]);
  });

  it("#6 never offers electric fireplaces, heaters or radiators", () => {
    expect(isAppliance("Home Furnishings > Home Décor > Fireplaces & Accessories > Electric Fireplaces", "Foyer")).toBe(true);
    expect(isAppliance("Patio & Garden > Fire Pits", "Radiateur soufflant 1500 W")).toBe(true);
    expect(isAppliance("Home Furnishings > Home Décor > Fireplaces & Accessories", "Foyer électrique mural")).toBe(true);
    expect(isAppliance("Home Furnishings > Home Décor > Fireplaces & Accessories", "Chauffage d'appoint céramique")).toBe(true);
    expect(isAppliance("Home Furnishings > Home Décor > Fireplaces & Accessories", "Râtelier à bûches avec 4 outils")).toBe(false);
    // Real-data check: "électrique" alone is not an appliance outside the fireplace/heating area.
    expect(isAppliance("Toys & Games > Electric Ride-On Toys > Electric Toy Cars", "Auto électrique pour enfants 12V")).toBe(false);
    expect(isAppliance("Office Products > Office Furniture > Office Cabinets & Cupboards", "Classeur mobile avec prises électriques")).toBe(false);
    const fire: OrderLineInput = { productId: "9", productType: "Patio & Garden > Fire Pits", title: "Foyer extérieur", price: 269.99 };
    const heater = cand({ title: "Chauffage tour céramique effet flamme", type: "Home Furnishings > Home Décor > Fireplaces & Accessories", price: 79.99 });
    const rack = cand({ title: "Râtelier à bûches", type: "Patio & Garden > Firewood Racks", price: 79.88 });
    expect(pickOffers([fire], [heater, rack], { now: NOV }).picks.map((p) => p.title)).toEqual(["Râtelier à bûches"]);
  });

  it("#11 Christmas items stop after December 15 (Montréal time)", () => {
    expect(outOfSeason(TREE, 12, 15)).toBe(false);
    expect(outOfSeason(TREE, 12, 16)).toBe(true);
    const wreath = cand({ title: "Couronne", type: "Holiday Decor > Christmas Decorations > Wreaths", price: 60 });
    expect(pickOffers([tree], [wreath], { now: new Date("2026-12-15T20:00:00Z") }).picks).toHaveLength(1);
    expect(pickOffers([tree], [wreath], { now: new Date("2026-12-16T15:00:00Z") }).picks).toHaveLength(0);
  });

  it("#14 the Christmas tree rule has no dead « Artificial Trees » target", () => {
    const rule = COMPLEMENT_MAP.find((r) => r.anchor.test(TREE));
    expect(rule?.targets).not.toContain("Artificial Trees");
  });

  it("choosePair: main + first of another type, and ranked is exposed for the live re-check", () => {
    expect(choosePair([{ type: "a" }, { type: "a" }, { type: "b" }]).map((x) => x.type)).toEqual(["a", "b"]);
    expect(choosePair([])).toEqual([]);
    const res = pickOffers([sofa], [cand({ price: 53 }), cand({ price: 54 }), cand({ type: L, price: 40 })], { now: NOV });
    expect(res.ranked.length).toBe(3);
  });
});
