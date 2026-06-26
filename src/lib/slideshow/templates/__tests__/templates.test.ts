import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import {
  buildShowcase,
  buildBestSellers,
  buildPriceDrop,
  buildUrgency,
  buildLookbook,
  buildDiscovery,
  buildSlideshow,
  type BaseTemplateOptions,
} from "@/lib/slideshow/templates";
import { SlideshowTemplate } from "@/lib/slideshow/types";
import { __setSelectorDbForTests } from "@/lib/selectors/db";
import { clearSelectorCache } from "@/lib/selectors/cache";
import { __setImageResolverForTests, clearImageCache } from "@/lib/selectors/shopify-images";

const CDN = "https://cdn.shopify.com/s/files/1/0001/0002/files";

/** Fresh in-memory catalog with the columns the selectors query. */
async function seedDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await db.batch([
    `CREATE TABLE products (
      sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER, product_type TEXT,
      shopify_product_id TEXT, shopify_handle TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL,
      old_price REAL, new_price REAL, old_qty INTEGER, new_qty INTEGER,
      change_type TEXT, detected_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
  ]);
  return db;
}

const now = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => now - d * 86400;

const insertProduct = (
  sku: string,
  name: string,
  price: number,
  qty: number,
  type = "Patio",
) => ({
  sql: `INSERT INTO products (sku, name, price, qty, product_type, shopify_product_id, shopify_handle)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
  args: [sku, name, price, qty, type, `sp-${sku}`, sku.toLowerCase()],
});

/** Base options shared by the dry-run tests (FR ameublo reel). */
const BASE: BaseTemplateOptions = { ratio: "9:16", brand: "ameublo", dryRun: true };

beforeEach(() => {
  clearSelectorCache();
  clearImageCache();
  // Deterministic, network-free Shopify-CDN images keyed by product id.
  __setImageResolverForTests(async (id) => [`${CDN}/${id}-1.jpg`, `${CDN}/${id}-2.jpg`]);
});

afterEach(() => {
  __setSelectorDbForTests(null);
  __setImageResolverForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("dry run returns a manifest and uploads nothing", () => {
  it("BEST_SELLERS: manifest only, every image is a cdn.shopify.com URL", async () => {
    const db = await seedDb();
    await db.batch(
      [
        insertProduct("A", "Chaise de jardin A", 99, 10),
        insertProduct("B", "Table de patio B", 149, 10),
        { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('A',50,20,'stock_change',?)`, args: [daysAgo(3)] },
        { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('B',100,95,'stock_change',?)`, args: [daysAgo(2)] },
      ],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildBestSellers({ ...BASE });
    expect(result.blobUrl).toBeUndefined();
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.dryRun).toBe(true);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.manifest?.template).toBe("BEST_SELLERS");
    expect(result.manifest?.title).toBe("Nos best-sellers du moment");
    expect(result.manifest?.wouldUploadTo).toMatch(/^slideshows\/ameublo\/best_sellers\/9x16\/\d+\.mp4$/);
    // A (velocity 30) ranks ahead of B (velocity 5).
    expect(result.manifest?.items[0].sku).toBe("A");
    for (const item of result.manifest!.items) {
      expect(item.image_url.startsWith("https://cdn.shopify.com/")).toBe(true);
    }
    db.close();
  });

  it("EN brand (furnish) defaults to English copy", async () => {
    const db = await seedDb();
    await db.batch(
      [
        insertProduct("A", "Garden chair", 99, 10),
        { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('A',50,20,'stock_change',?)`, args: [daysAgo(3)] },
      ],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildBestSellers({ ratio: "9:16", brand: "furnish", dryRun: true });
    expect(result.manifest?.language).toBe("en");
    expect(result.manifest?.title).toBe("Our top picks right now");
    db.close();
  });
});

describe("PRICE_DROP filters to rabais >= 10% and badges them", () => {
  it("keeps only compare_at >= price * 1.10 and shows the badge", async () => {
    const db = await seedDb();
    await db.batch(
      [
        insertProduct("DEEP", "Sofa rabais profond", 80, 5),
        insertProduct("SHALLOW", "Sofa petit rabais", 100, 5),
        // DEEP: old 100 vs price 80 → 25% (kept). SHALLOW: old 105 vs 100 → 5% (dropped).
        { sql: `INSERT INTO price_history (sku, old_price, new_price, change_type, detected_at) VALUES ('DEEP',100,80,'price_drop',?)`, args: [daysAgo(1)] },
        { sql: `INSERT INTO price_history (sku, old_price, new_price, change_type, detected_at) VALUES ('SHALLOW',105,100,'price_drop',?)`, args: [daysAgo(1)] },
      ],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildPriceDrop({ ...BASE, minPct: 10 });
    const items = result.manifest!.items;
    expect(items.map((i) => i.sku)).toEqual(["DEEP"]); // SHALLOW (< 10%) excluded
    expect(items[0].showsBadge).toBe(true);
    expect(items[0].compare_at).toBe(100);
    expect(items[0].discountPct).toBe(20); // (100-80)/100
    expect(result.manifest?.title).toBe("Prix baissés 📉");
    db.close();
  });
});

describe("URGENCY returns only qty <= threshold, scarcest first", () => {
  it("excludes out-of-stock and above-threshold, and writes the scarcity overlay", async () => {
    const db = await seedDb();
    await db.batch(
      [
        insertProduct("OUT", "Rupture", 10, 0),
        insertProduct("LOW", "Presque fini", 10, 2),
        insertProduct("MID", "Stock moyen", 10, 4),
        insertProduct("HIGH", "Plein stock", 10, 50),
      ],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildUrgency({ ...BASE, threshold: 5 });
    const items = result.manifest!.items;
    expect(items.map((i) => i.sku)).toEqual(["LOW", "MID"]); // OUT (0) and HIGH (50) excluded
    // Overlay leads with the scarcity line (formatVideoTitle keeps it intact).
    expect(items[0].overlay_text).toContain("Plus que 2");
    expect(items[1].overlay_text).toContain("Plus que 4");
    expect(result.manifest?.title).toBe("Dernière chance 🔥");
    db.close();
  });

  it("uses English scarcity copy for the furnish brand", async () => {
    const db = await seedDb();
    await db.batch([insertProduct("LOW", "Almost gone", 10, 3)], "write");
    __setSelectorDbForTests(db);

    const result = await buildUrgency({ ratio: "1:1", brand: "furnish", dryRun: true, threshold: 5 });
    expect(result.manifest!.items[0].overlay_text).toContain("Only 3 left!");
    db.close();
  });
});

describe("SHOWCASE builds one slide per Shopify-CDN image of a single SKU", () => {
  it("uses the product's image series with the same overlay on each slide", async () => {
    const db = await seedDb();
    await db.batch([insertProduct("HERO", "Lit king ensemble", 599, 8)], "write");
    __setSelectorDbForTests(db);

    const result = await buildShowcase("HERO", { ...BASE });
    const items = result.manifest!.items;
    // Resolver stub yields 2 images for the product id → 2 slides.
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.sku))).toEqual(new Set(["HERO"]));
    expect(items[0].overlay_text).toBe(items[1].overlay_text);
    for (const item of items) {
      expect(item.image_url.startsWith("https://cdn.shopify.com/")).toBe(true);
    }
    // Intro card carries store identity, not the product name.
    expect(result.manifest?.title).toContain("Ameublo Direct");
    db.close();
  });

  it("throws on an unknown SKU", async () => {
    const db = await seedDb();
    __setSelectorDbForTests(db);
    await expect(buildShowcase("NOPE", { ...BASE })).rejects.toThrow(/not found/);
    db.close();
  });
});

describe("DISCOVERY", () => {
  it("renders a random-strategy discovery manifest", async () => {
    const db = await seedDb();
    await db.batch(
      [insertProduct("X", "Découverte X", 75, 5), insertProduct("Y", "Découverte Y", 120, 5)],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildDiscovery({ ...BASE, strategy: "random" });
    expect(result.manifest).toBeDefined();
    expect(result.manifest?.template).toBe("DISCOVERY");
    expect(result.manifest?.title).toBe("Découverte du moment ✨");
    expect(result.manifest!.items.length).toBeGreaterThan(0);
    db.close();
  });
});

describe("LOOKBOOK falls back to product-only when no B-roll provider is configured", () => {
  it("does not throw and warns, with PEXELS/UNSPLASH unset", async () => {
    vi.stubEnv("PEXELS_API_KEY", "");
    vi.stubEnv("UNSPLASH_ACCESS_KEY", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const db = await seedDb();
    await db.batch(
      [insertProduct("P", "Salon d'ambiance", 199, 5, "Patio"), insertProduct("Q", "Fauteuil", 89, 5, "Patio")],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildLookbook({ ...BASE, category: "Patio" });
    expect(result.manifest).toBeDefined();
    expect(result.blobUrl).toBeUndefined();
    expect(result.manifest!.items.length).toBeGreaterThan(0);
    expect(result.manifest?.title).toBe("Inspirez votre espace");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no B-roll provider configured"));
    for (const item of result.manifest!.items) {
      expect(item.image_url.startsWith("https://cdn.shopify.com/")).toBe(true);
    }
    db.close();
  });
});

describe("buildSlideshow factory", () => {
  it("routes a template to its builder", async () => {
    const db = await seedDb();
    await db.batch(
      [
        insertProduct("A", "Chaise A", 99, 10),
        { sql: `INSERT INTO price_history (sku, old_qty, new_qty, change_type, detected_at) VALUES ('A',50,20,'stock_change',?)`, args: [daysAgo(3)] },
      ],
      "write",
    );
    __setSelectorDbForTests(db);

    const result = await buildSlideshow(SlideshowTemplate.BEST_SELLERS, { ...BASE });
    expect(result.manifest?.template).toBe("BEST_SELLERS");
    db.close();
  });

  it("requires sku for SHOWCASE and strategy for DISCOVERY, and rejects unsupported templates", async () => {
    await expect(buildSlideshow(SlideshowTemplate.SHOWCASE, { ...BASE })).rejects.toThrow(/sku is required/);
    await expect(buildSlideshow(SlideshowTemplate.DISCOVERY, { ...BASE })).rejects.toThrow(/strategy is required/);
    await expect(buildSlideshow(SlideshowTemplate.COUNTDOWN, { ...BASE })).rejects.toThrow(/unsupported template/);
  });
});

describe("no-renderable-products guard", () => {
  it("throws a clear error when a selector yields nothing", async () => {
    const db = await seedDb(); // empty catalog → bestSellers returns []
    __setSelectorDbForTests(db);
    await expect(buildBestSellers({ ...BASE })).rejects.toThrow(/no products with a Shopify-CDN image/);
    db.close();
  });
});
