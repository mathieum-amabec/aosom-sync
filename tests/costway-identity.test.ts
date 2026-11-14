/**
 * Neutral identity for Costway products: opaque internal SKU, neutral image filenames, and the
 * leak gate. The DB-backed part runs against the REAL schema in an in-memory libsql DB.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

// Real feed has ~22k rows; the absolute floor would reject a 3-row fixture.
vi.mock("@/lib/config", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/config")>();
  return { ...orig, COSTWAY: { ...orig.COSTWAY, MIN_ROWS_ABSOLUTE: 1 } };
});

import { csv } from "./fixtures/costway-csv";
import { internalSkuFor, isInternalSku, neutralImageFilename, findCostwayLeaks } from "@/lib/costway/identity";
import { stripSupplierBrands, forbiddenBrandsIn } from "@/lib/catalog-guard";

let db: Client;
let assignInternalSkus: typeof import("@/lib/costway/identity").assignInternalSkus;
let runCostwaySync: typeof import("@/lib/costway/sync").runCostwaySync;

beforeAll(async () => {
  const database = await import("@/lib/database");
  db = await database.ensureSchema();
  ({ assignInternalSkus } = await import("@/lib/costway/identity"));
  ({ runCostwaySync } = await import("@/lib/costway/sync"));
});

beforeEach(async () => {
  await db.execute(`DELETE FROM costway_products`);
  await db.execute(`DELETE FROM products`);
});

describe("internalSkuFor", () => {
  it("is opaque: nothing of the supplier SKU or item number survives", () => {
    const sku = internalSkuFor("02956471_CB10061BK", () => false);
    expect(isInternalSku(sku)).toBe(true);
    expect(sku).toHaveLength(8);
    expect(sku.toLowerCase()).not.toContain("02956471");
    expect(sku.toLowerCase()).not.toContain("cb10061");
  });
  it("is deterministic and differs between variants", () => {
    expect(internalSkuFor("111_BK", () => false)).toBe(internalSkuFor("111_BK", () => false));
    expect(internalSkuFor("111_BK", () => false)).not.toBe(internalSkuFor("111_WH", () => false));
  });
  it("re-hashes past a collision instead of failing", () => {
    const first = internalSkuFor("111_BK", () => false);
    const second = internalSkuFor("111_BK", (c) => c === first);
    expect(second).not.toBe(first);
    expect(isInternalSku(second)).toBe(true);
  });
  it("never produces something that looks like a Costway or Aosom SKU", () => {
    for (let i = 0; i < 500; i++) {
      const s = internalSkuFor(`${10000000 + i}_X${i}`, () => false);
      expect(s).not.toMatch(/-/);
      expect(s).not.toMatch(/^\d/);
    }
  });
});

describe("neutralImageFilename", () => {
  it("names images after the internal SKU, keeping a sane extension", () => {
    expect(neutralImageFilename("M7H3K9Q2", 0, "https://assets.costway.ca/media/catalog/product/c/b/cb10061bk.jpg")).toBe("m7h3k9q2-1.jpg");
    expect(neutralImageFilename("M7H3K9Q2", 2, "https://x/y/photo.PNG?v=3")).toBe("m7h3k9q2-3.png");
    expect(neutralImageFilename("M7H3K9Q2", 0, "https://x/y/noext")).toBe("m7h3k9q2-1.jpg");
  });
});

describe("Costway is a forbidden supplier name", () => {
  it("is stripped from titles and detected in HTML, in any case", () => {
    expect(stripSupplierBrands("COSTWAY Chaise longue").replace(/\s+/g, " ")).toBe("Chaise longue");
    expect(forbiddenBrandsIn("<p>Un produit Costway fiable</p>").map((b) => b.toLowerCase())).toContain("costway");
  });
});

describe("findCostwayLeaks", () => {
  it("flags the brand, its domain, the supplier SKU and the item number", () => {
    expect(findCostwayLeaks("Acheté chez Costway")).toContain("costway");
    expect(findCostwayLeaks("voir https://www.costway.ca/chair")).toContain("costway domain");
    expect(findCostwayLeaks("Réf 02956471_CB10061BK", ["02956471_CB10061BK"])).toContain("supplier SKU 02956471_CB10061BK");
    expect(findCostwayLeaks("modèle 02956471 noir", ["02956471_CB10061BK"])).toContain("supplier item no. 02956471");
  });
  it("passes clean text and does not mistake a longer number for the item number", () => {
    expect(findCostwayLeaks("Chaise ergonomique en mesh", ["02956471_CB10061BK"])).toEqual([]);
    expect(findCostwayLeaks("code 1029564719", ["02956471_CB10061BK"])).toEqual([]);
    expect(findCostwayLeaks(null)).toEqual([]);
  });
});

const feed = csv(
  { "Item No": "111", "Variant SKU": "111_BK", Title: "Chaise", "Option1 Value": "Black", "Variant Price": "100" },
  { "Item No": "111", "Variant SKU": "111_WH", Title: "Chaise", "Option1 Value": "White", "Variant Price": "110" },
  { "Item No": "222", "Variant SKU": "222_GY", Title: "Parasol", "Variant Price": "50" },
);

describe("assignInternalSkus (real schema)", () => {
  it("assigns unique opaque SKUs only to the requested variants, and is idempotent", async () => {
    await runCostwaySync({ text: feed });
    const first = await assignInternalSkus(["111_BK", "111_WH"]);
    expect(first.size).toBe(2);
    expect(new Set(first.values()).size).toBe(2);
    for (const v of first.values()) expect(isInternalSku(v)).toBe(true);

    const again = await assignInternalSkus(["111_BK", "111_WH", "111_BK"]);
    expect(again.get("111_BK")).toBe(first.get("111_BK"));

    // 222_GY was never requested → never written.
    const row = (await db.execute(`SELECT internal_sku FROM costway_products WHERE sku = '222_GY'`)).rows[0] as unknown as { internal_sku: string | null };
    expect(row.internal_sku).toBeNull();
  });

  it("skips SKUs that are not in the Costway catalogue", async () => {
    await runCostwaySync({ text: feed });
    const out = await assignInternalSkus(["999_NOPE"]);
    expect(out.size).toBe(0);
  });

  it("steps over a SKU already used by an AOSOM product", async () => {
    await runCostwaySync({ text: feed });
    const wanted = internalSkuFor("222_GY", () => false);
    await db.execute({ sql: `INSERT INTO products (sku, name) VALUES (?, 'x')`, args: [wanted] });
    const out = await assignInternalSkus(["222_GY"]);
    expect(out.get("222_GY")).not.toBe(wanted);
  });

  it("the unique index makes a duplicate internal SKU impossible", async () => {
    await runCostwaySync({ text: feed });
    await db.execute(`UPDATE costway_products SET internal_sku = 'MAAAAAAA' WHERE sku = '111_BK'`);
    await expect(db.execute(`UPDATE costway_products SET internal_sku = 'MAAAAAAA' WHERE sku = '111_WH'`)).rejects.toThrow(/UNIQUE|constraint/i);
  });
});
