/**
 * Costway importer: candidate selection, preparation gates and the apply flow, against the REAL schema
 * (in-memory libsql) with Shopify / the LLM replaced by fakes.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import type { GeneratedContent } from "@/lib/content-generator";
import type { AosomMergedProduct } from "@/types/aosom";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

import {
  selectCandidates, selectDemandCandidates, prepareCandidate, applyPrepared, candidateMargin, unionImages, galleryFor,
  type Candidate, type PrepareDeps, type ApplyDeps, type CreatedProduct, type PreparedItem,
} from "@/lib/costway/importer";
import { matchAosomType, stems, type AosomTypeDemand } from "@/lib/costway/demand";
import { isInternalSku } from "@/lib/costway/identity";

let db: Client;
beforeAll(async () => {
  const database = await import("@/lib/database");
  db = await database.ensureSchema();
});

const IMGS = (n: number, tag = "a") => JSON.stringify(Array.from({ length: n }, (_, i) => `https://assets.costway.ca/media/catalog/product/${tag}/${i}/cb1000${i}.jpg`));

async function insert(r: {
  sku: string; item: string; title: string; category: string; price: number; qty?: number; ca?: number; inStock?: number;
  images?: number; tag?: string; priceDrop?: number | null; color?: string; shopifyId?: string | null; body?: string;
}) {
  await db.execute({
    sql: `INSERT INTO costway_products (sku, item_no, title, body_html, category, color, price, price_drop, promo_tag, in_stock, qty, ca_qty, us_qty, images, content_hash, shopify_product_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [r.sku, r.item, r.title, r.body ?? "<p>Great product</p>", r.category, r.color ?? "White", r.price, r.priceDrop ?? null, r.tag ?? "",
      r.inStock ?? 1, r.qty ?? 100, r.ca ?? 0, 0, IMGS(r.images ?? 6, r.item), "h", r.shopifyId ?? null],
  });
}

const DEHUM = "Appliances > Climate Control Appliances > Dehumidifiers";
const WASH = "Appliances > Washers & Dryers > Washing Machines";
const DRY = "Appliances > Washers & Dryers > Dryers";

beforeEach(async () => {
  await db.execute(`DELETE FROM costway_products`);
  await db.execute(`DELETE FROM products`);
});

describe("what will sell: Aosom product types and selectDemandCandidates", () => {
  const T = (type: string, perSku: number, skus = 20): AosomTypeDemand => ({ type, perSku, skus, units: perSku * skus });
  const types = [
    T("Home Furnishings > Kitchen & Dining Furniture > Bar Stools", 15),
    T("Home Furnishings > Bedroom Furniture > Wall Mirrors", 4),
    T("Home Furnishings > Bedroom Furniture > Bedside Tables", 21),
    T("Holiday & Seasonal > Christmas Trees", 8),
    T("Toys & Games > Baby & Toddler Toys > Play Kitchen", 30),
    T("Patio & Garden > Patio Furniture > Patio Furniture Sets", 25),
    T("Sports & Recreation > Bikes & Scooters > Bike Trailers > Kids Bike Trailers", 5),
  ];

  it("matches a Costway category to the closest Aosom product type, and refuses a one-word overlap", () => {
    expect(matchAosomType("Furniture > Kitchen & Dining > Bar Stools", types)?.type).toContain("Bar Stools");
    expect(matchAosomType("Furniture > Bedroom > Nightstands", types)?.type).toContain("Bedside Tables");
    expect(matchAosomType("Decor > Holiday Decor > Christmas > Christmas Tree", types)?.type).toBe("Holiday & Seasonal > Christmas Trees");
    expect(matchAosomType("Toys & Hobbies > Ride On Toys > Kids Bike", types)).toBeNull();
    expect([...stems("Wall Mirrors & Accessories")]).toEqual(["wall", "mirror"]);
  });

  it("keeps big sellers, Christmas in season, no toys and no patio out of season, ranked by expected margin dollars", async () => {
    await insert({ sku: "s1", item: "s1", title: "Bar Stool Set of 2", category: "Furniture > Kitchen & Dining > Bar Stools", price: 150, ca: 40 });
    await insert({ sku: "n1", item: "n1", title: "Nightstand with Drawer", category: "Furniture > Bedroom > Nightstands", price: 120, ca: 40 });
    await insert({ sku: "m1", item: "m1", title: "Wall Mirror", category: "Decor > Mirrors > Wall Mirrors", price: 90, ca: 40 });          // 4/SKU: too slow
    await insert({ sku: "x1", item: "x1", title: "7ft Christmas Tree", category: "Decor > Holiday Decor > Christmas > Christmas Tree", price: 140, ca: 40 }); // seasonal
    await insert({ sku: "k1", item: "k1", title: "Play Kitchen", category: "Toys & Hobbies > Pretend Toys > Play Kitchen Sets", price: 140, ca: 40 }); // toys
    await insert({ sku: "p1", item: "p1", title: "Patio Set", category: "Outdoor > Patio Furniture Sets", price: 400, ca: 40 });           // patio, not winter
    await insert({ sku: "u1", item: "u1", title: "Bar Stool US only", category: "Furniture > Kitchen & Dining > Bar Stools", price: 150, ca: 0 }); // no CA stock
    const out = await selectDemandCandidates(db, { limit: 10, aosomTypes: types, now: new Date("2026-10-17T12:00:00Z") });
    // nightstand 21/SKU x 30.19 $ > stools 15 x 37.99 $ > the seasonal tree 8 x 35.39 $
    expect(out.map((c) => c.itemNo)).toEqual(["n1", "s1", "x1"]);
    expect(out[1]).toMatchObject({ kind: "general", productType: "Home Furnishings > Kitchen & Dining Furniture > Bar Stools", expectedDemand: 15 });
    const summer = await selectDemandCandidates(db, { limit: 10, aosomTypes: types, now: new Date("2026-07-01T12:00:00Z") });
    expect(summer.map((c) => c.itemNo)).not.toContain("x1");
  });

  it("uses Costway's own sales instead of the Aosom estimate when they are given", async () => {
    await insert({ sku: "m1", item: "m1", title: "Wall Mirror", category: "Decor > Mirrors > Wall Mirrors", price: 90, ca: 40 });
    const out = await selectDemandCandidates(db, { limit: 10, aosomTypes: types, costwayDemand: new Map([["m1", 30]]) });
    expect(out.map((c) => c.itemNo)).toEqual(["m1"]);
    expect(out[0].expectedDemand).toBe(30);
  });
});

describe("selectCandidates", () => {
  it("keeps eligible products, ranks by margin, and drops everything the pilot must not touch", async () => {
    await insert({ sku: "1_A", item: "1", title: "180 PPD Commercial Dehumidifier with Pump", category: DEHUM, price: 830 });
    await insert({ sku: "2_A", item: "2", title: "Portable Automatic Laundry Washing Machine", category: WASH, price: 300 });
    await insert({ sku: "3_A", item: "3", title: "25L Towel Warmer Bucket with Auto Shut Off", category: DRY, price: 130 });   // mis-filed
    await insert({ sku: "4_A", item: "4", title: "32 Pint Dehumidifier for Home", category: DEHUM, price: 180, qty: 2 });     // thin stock
    await insert({ sku: "5_A", item: "5", title: "60 Pint Dehumidifier for Basements", category: DEHUM, price: 250, images: 3 }); // few images
    await insert({ sku: "6_A", item: "6", title: "70 Pint Dehumidifier for Basements", category: DEHUM, price: 290, shopifyId: "999" }); // already imported
    await insert({ sku: "7_A", item: "7", title: "Laundry Room Bundle: Cabinet and Dryer", category: DRY, price: 650 });       // bundle
    const out = await selectCandidates(db, { limit: 10 });
    expect(out.map((c) => c.itemNo)).toEqual(["1", "2"]);
    expect(out[0].kind).toBe("dehumidifier");
    expect(out[1].kind).toBe("washer");
  });

  it("honours the limit and groups colour variants of one item", async () => {
    await insert({ sku: "1_BK", item: "1", title: "Portable Washing Machine 18 lbs", category: WASH, price: 200, color: "Black" });
    await insert({ sku: "1_WH", item: "1", title: "Portable Washing Machine 18 lbs", category: WASH, price: 210, color: "White" });
    await insert({ sku: "2_A", item: "2", title: "Dehumidifier 30 Pints", category: DEHUM, price: 150 });
    const all = await selectCandidates(db, { limit: 10 });
    expect(all.find((c) => c.itemNo === "1")?.variants).toHaveLength(2);
    expect(await selectCandidates(db, { limit: 1 })).toHaveLength(1);
  });

  it("measures margin on the cheapest sellable variant, at Costway's price (same on a Drop Price item)", async () => {
    await insert({ sku: "1_A", item: "1", title: "Dehumidifier 60 Pints", category: DEHUM, price: 479.99, tag: "Drop Price" });
    const [c] = await selectCandidates(db, { limit: 1 });
    const m = candidateMargin(c);
    expect(m.sell).toBe(479.99);
    expect(m.dollars).toBeCloseTo(479.99 * 0.16, 1);
  });

  it("unionImages de-duplicates, keeps variant order and caps at 8", () => {
    const v = (images: string[]) => ({ sku: "x", color: "", feedPrice: 1, priceDrop: null, promoTag: "", qty: 5, caQty: 0, usQty: 0, images });
    const urls = Array.from({ length: 12 }, (_, i) => `https://x/${i}.jpg`);
    expect(unionImages([v(urls.slice(0, 6)), v(urls.slice(3, 12))])).toEqual(urls.slice(0, 8));
  });
});

// Everything that can reach the LLM / Shopify as TEXT. The image URLs stay on the merged product only so photos can be
// matched to variants; createShopifyProduct is told not to ingest them (images: []) and they are re-uploaded under neutral names.
const textOnly = (m: AosomMergedProduct) => JSON.stringify({ ...m, images: undefined, variants: m.variants.map((v) => ({ ...v, images: undefined })) });

// ── prepare ──
const goodContent = (over: Partial<GeneratedContent> = {}): GeneratedContent => ({
  titleFr: "Déshumidificateur commercial 180 pintes", titleEn: "Commercial dehumidifier 180 pints",
  descriptionFr: "<p>Ce déshumidificateur protège votre sous-sol de l'humidité toute l'année.</p>", descriptionEn: "<p>Protects your basement.</p>",
  seoDescriptionFr: "d", seoDescriptionEn: "d", metaTitleFr: "m | Livraison gratuite — Ameublo Direct", metaTitleEn: "m | Free Shipping — Furnish Direct",
  metaDescriptionFr: "md", metaDescriptionEn: "md", urlHandleFr: "deshumidificateur-commercial", urlHandleEn: "commercial-dehumidifier",
  tags: ["déshumidificateur", "sous-sol"], brand: "Ameublo Direct", ...over,
}) as GeneratedContent;

function prepDeps(over: Partial<PrepareDeps> = {}, seen: AosomMergedProduct[] = []): PrepareDeps {
  return {
    generate: async (m) => { seen.push(m); return goodContent(); },
    guardImages: async (urls) => ({ images: urls, outcome: "clean" }),
    qualityGates: async () => ({ failures: [] }),
    cleanHtml: (h) => h,
    ...over,
  };
}

async function oneCandidate(opts: Partial<{ tag: string; qty: number; price: number; priceDrop: number | null }> = {}): Promise<Candidate> {
  await insert({ sku: "02956471_CB10061BK", item: "02956471", title: "180 PPD Commercial Dehumidifier with Pump", category: DEHUM, price: opts.price ?? 829.99, tag: opts.tag, qty: opts.qty ?? 644, priceDrop: opts.priceDrop ?? null });
  return (await selectCandidates(db, { limit: 1 }))[0];
}

describe("prepareCandidate", () => {
  it("is ready when every gate passes, prices at Costway's price and caps the sellable stock", async () => {
    const c = await oneCandidate();
    const p = await prepareCandidate(c, prepDeps());
    expect(p.problems).toEqual([]);
    expect(p.variants[0]).toMatchObject({ feedPrice: 829.99, sellPrice: 829.99, sellQty: 50 });
    expect(p.productType).toBe("Home Furnishings > Appliances > Dehumidifiers");
  });

  it("never shows the LLM a supplier SKU or the supplier name, and uses the store brand", async () => {
    const c = await oneCandidate();
    const seen: AosomMergedProduct[] = [];
    await prepareCandidate(c, prepDeps({}, seen));
    const m = seen[0];
    expect(m.brand).toBe("Ameublo Direct");
    expect(m.variants.map((v) => v.sku)).toEqual(["V1"]);
    expect(textOnly(m)).not.toMatch(/02956471|CB10061|costway/i);
  });

  it("blocks a listing that leaks the supplier (name, domain, SKU or item number)", async () => {
    const c = await oneCandidate();
    for (const bad of [
      goodContent({ descriptionFr: "<p>Acheté chez Costway, déshumidificateur fiable pour votre sous-sol.</p>" }),
      goodContent({ tags: ["costway"] }),
      goodContent({ titleFr: "Déshumidificateur 02956471" }),
      goodContent({ urlHandleFr: "02956471_CB10061BK" }),
    ]) {
      const p = await prepareCandidate(c, prepDeps({ generate: async () => bad }));
      expect(p.problems.some((x) => x.startsWith("leak:"))).toBe(true);
    }
  });

  it("blocks when no photo is clean, or the language / brand gate fails", async () => {
    const c = await oneCandidate();
    const p1 = await prepareCandidate(c, prepDeps({ guardImages: async (u) => ({ images: u, outcome: "no_alternative" }) }));
    expect(p1.problems.some((x) => x.startsWith("image_not_clean"))).toBe(true);
    const p2 = await prepareCandidate(c, prepDeps({ qualityGates: async () => ({ failures: ["not_french"] }) }));
    expect(p2.problems).toContain("gate:not_french");
  });

  it("prices a Drop Price item like any other and honours the Price Drop floor", async () => {
    const dropped = await prepareCandidate(await oneCandidate({ tag: "Drop Price", price: 479.99 }), prepDeps());
    expect(dropped.variants[0].sellPrice).toBe(479.99);
    await db.execute(`DELETE FROM costway_products`);
    const floored = await prepareCandidate(await oneCandidate({ tag: "Drop Price", price: 479.99, priceDrop: 600 }), prepDeps());
    expect(floored.variants[0].sellPrice).toBe(600.99);
  });

  it("names each size of a same-colour family, smallest first, and drops the lone size from the title", async () => {
    const c: Candidate = {
      itemNo: "1", title: "PVC Slim Pencil Christmas Tree-7 Feet", bodyHtml: "", category: "", kind: "general",
      variants: [7, 5, 6].map((ft) => ({
        sku: `S${ft}`, title: `PVC Slim Pencil Christmas Tree-${ft} Feet`, color: "Green", feedPrice: 50 + ft, priceDrop: null,
        promoTag: "", qty: 100, caQty: 100, usQty: 0, images: [],
      })),
    };
    const seen: AosomMergedProduct[] = [];
    const generate = async (m: AosomMergedProduct) => { seen.push(m); return goodContent({ titleFr: "Arbre de Noël mince 213 cm" }); };
    const p = await prepareCandidate(c, prepDeps({ generate }));
    expect(p.problems).toEqual([]);
    expect(p.variants.map((v) => [v.supplierSku, v.size, v.color])).toEqual([
      ["S5", "5 ft (152 cm)", ""], ["S6", "6 ft (183 cm)", ""], ["S7", "7 ft (213 cm)", ""],
    ]);
    expect(seen[0].variants.map((v) => v.color)).toEqual(["", "", ""]);
    expect(p.content.titleFr).toBe("Arbre de Noël mince");
  });

  it("blocks a same-colour family whose variants nothing tells apart", async () => {
    const c: Candidate = {
      itemNo: "2", title: "Tree", bodyHtml: "", category: "", kind: "general",
      variants: ["A", "B"].map((s) => ({ sku: s, title: `Tree with lights ${s}`, color: "Green", feedPrice: 60, priceDrop: null, promoTag: "", qty: 100, caQty: 100, usQty: 0, images: [] })),
    };
    const p = await prepareCandidate(c, prepDeps());
    expect(p.problems.some((x) => x.startsWith("variants:"))).toBe(true);
  });
});

// ── apply ──
interface Trace { events: string[]; created?: AosomMergedProduct; uploads: Array<{ filename: string; position: number }>; stock: Array<[string, number]> }

function applyDeps(trace: Trace, over: Partial<ApplyDeps> = {}, productOver: Partial<CreatedProduct> = {}): ApplyDeps {
  let merged: AosomMergedProduct | null = null;
  return {
    db,
    now: () => 1_700_000_000,
    sleep: async () => {},
    createProduct: async (m) => { merged = m; trace.created = m; trace.events.push("create"); return { id: "777", handle: "deshumidificateur-commercial" }; },
    downloadImage: async () => "QUJD",
    uploadImage: async (_id, img) => {
      const row = (await db.execute(`SELECT shopify_product_id FROM costway_products LIMIT 1`)).rows[0] as unknown as { shopify_product_id: string | null };
      trace.events.push(row.shopify_product_id ? "upload(linked)" : "upload(NOT linked)");
      trace.uploads.push({ filename: img.filename, position: img.position });
    },
    getProduct: async () => ({
      id: "777", handle: "deshumidificateur-commercial", status: "draft", tags: ["déshumidificateur", "src-c"], vendor: "Ameublo Direct",
      productType: "Home Furnishings > Appliances > Dehumidifiers", title: "Déshumidificateur commercial 180 pintes", bodyHtml: "<p>ok</p>",
      variants: (merged?.variants ?? []).map((v, i) => ({ id: `v${i}`, sku: v.sku, inventoryItemId: `inv${i}`, option1: null })),
      images: trace.uploads.map((u, i) => ({ id: `i${i}`, src: `https://cdn.shopify.com/s/files/${u.filename}`, alt: "x" })),
      ...productOver,
    }),
    attachVariantImages: async () => 0,
    trackInventory: async (inv, qty) => { trace.stock.push([inv, qty]); },
    ...over,
  };
}

async function prepared(): Promise<PreparedItem> {
  return prepareCandidate(await oneCandidate(), prepDeps());
}

describe("applyPrepared", () => {
  it("creates a draft with internal SKUs, links it BEFORE uploading images, uses neutral filenames and sets stock", async () => {
    const p = await prepared();
    const trace: Trace = { events: [], uploads: [], stock: [] };
    const r = await applyPrepared(p, "pilot-1", applyDeps(trace));
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);

    // internal SKU on the Shopify variant, never the supplier's
    expect(trace.created!.variants.every((v) => isInternalSku(v.sku))).toBe(true);
    expect(textOnly(trace.created!)).not.toMatch(/02956471|CB10061/);
    // linked before the first image upload (the Aosom sweeps must already skip it)
    expect(trace.events[0]).toBe("create");
    expect(trace.events.slice(1).every((e) => e === "upload(linked)")).toBe(true);
    // neutral image names
    expect(trace.uploads.length).toBe(p.imageUrls.length);
    for (const u of trace.uploads) expect(u.filename).toMatch(/^m[0-9a-z]{7}-\d+\.jpg$/);
    expect(trace.uploads.map((u) => u.position)).toEqual(p.imageUrls.map((_, i) => i + 1));
    // stock = what we are willing to sell
    expect(trace.stock).toEqual([["inv0", 50]]);
    // tracking in aosom-sync
    const row = (await db.execute(`SELECT * FROM costway_products`)).rows[0] as unknown as Record<string, unknown>;
    expect(row).toMatchObject({ shopify_product_id: "777", shopify_handle: "deshumidificateur-commercial", import_batch: "pilot-1", import_status: "draft", sell_price: 829.99, imported_at: 1_700_000_000 });
    expect(isInternalSku(String(row.internal_sku))).toBe(true);
  });

  it("is idempotent: a second apply never creates a second product", async () => {
    const p = await prepared();
    const trace: Trace = { events: [], uploads: [], stock: [] };
    expect((await applyPrepared(p, "pilot-1", applyDeps(trace))).ok).toBe(true);
    const again = await applyPrepared(p, "pilot-1", applyDeps({ events: [], uploads: [], stock: [] }));
    expect(again.ok).toBe(false);
    expect(again.error).toBe("already imported");
  });

  it("refuses a product that still has problems", async () => {
    const p = { ...(await prepared()), problems: ["leak:costway"] };
    const trace: Trace = { events: [], uploads: [], stock: [] };
    const r = await applyPrepared(p, "pilot-1", applyDeps(trace));
    expect(r.ok).toBe(false);
    expect(trace.events).toEqual([]);
  });

  it("warns, loudly, if the product Shopify returns is not a clean draft", async () => {
    const p = await prepared();
    const trace: Trace = { events: [], uploads: [], stock: [] };
    const r = await applyPrepared(p, "pilot-1", applyDeps(trace, {}, { status: "active", tags: ["x"], vendor: "Costway" }));
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" | ")).toMatch(/status is active/);
    expect(r.warnings.join(" | ")).toMatch(/missing tag src-c/);
    expect(r.warnings.join(" | ")).toMatch(/LEAK/);
  });

  it("keeps going when one image fails and reports it", async () => {
    const p = await prepared();
    const trace: Trace = { events: [], uploads: [], stock: [] };
    let n = 0;
    const r = await applyPrepared(p, "pilot-1", applyDeps(trace, {
      downloadImage: async () => { if (++n === 2) throw new Error("download 404"); return "QUJD"; },
    }));
    expect(r.ok).toBe(true);
    expect(r.imagesUploaded).toBe(p.imageUrls.length - 1);
    expect(r.warnings.join(" | ")).toMatch(/image 2: download 404/);
  });
});

describe("galleryFor — every colour keeps a photo of its own", () => {
  const imgs = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `https://x/${tag}${i}.jpg`);
  it("keeps the primary first and reserves a slot for each other colour's first photo", () => {
    const g = galleryFor([{ images: imgs("g", 9) }, { images: imgs("w", 9) }], "https://x/g0.jpg");
    expect(g).toHaveLength(8);
    expect(g[0]).toBe("https://x/g0.jpg");
    expect(g).toContain("https://x/w0.jpg"); // the white variant's own photo survives the cap
  });
  it("handles many colours and the cap", () => {
    const g = galleryFor([0, 1, 2, 3, 4].map((i) => ({ images: imgs("c" + i + "_", 9) })), undefined, 8);
    expect(g).toHaveLength(8);
    for (let i = 1; i < 5; i++) expect(g).toContain(`https://x/c${i}_0.jpg`);
  });
  it("does not duplicate a photo shared by every colour", () => {
    const shared = imgs("s", 6);
    expect(galleryFor([{ images: shared }, { images: shared }])).toEqual(shared);
  });
});

describe("colours are translated to French before they reach Shopify", () => {
  it("gives the Shopify option values in French (Gray → Gris), like every Aosom import", async () => {
    await insert({ sku: "9_GY", item: "9", title: "Portable Washing Machine 18 lbs", category: WASH, price: 200, color: "Gray" });
    await insert({ sku: "9_WH", item: "9", title: "Portable Washing Machine 18 lbs", category: WASH, price: 200, color: "White" });
    const p = await prepareCandidate((await selectCandidates(db, { limit: 1 }))[0], prepDeps());
    const trace: Trace = { events: [], uploads: [], stock: [] };
    await applyPrepared(p, "pilot-1", applyDeps(trace));
    expect(trace.created!.variants.map((v) => v.color)).toEqual(["Gris", "Blanc"]);
  });
});
