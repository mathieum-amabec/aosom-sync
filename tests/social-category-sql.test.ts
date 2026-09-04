import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { SOCIAL_CATEGORIES, getCategory } from "@/lib/social-categories";

/**
 * Runs the REAL category predicates against a real SQLite table.
 *
 * The unit test in social-categories.test.ts checks the predicates as strings; this one
 * checks they are valid SQL that selects what the label promises. It is the test that would
 * catch a typo in a LIKE pattern, a wrong column, or a `strftime` that silently matches
 * nothing — none of which a string assertion can see.
 *
 * The rows mirror the real product_type values measured in production on 2026-09-03.
 */

const CREATE_PRODUCTS = `CREATE TABLE products (
  sku TEXT PRIMARY KEY, name TEXT, price REAL, qty INTEGER,
  shopify_product_id TEXT, last_posted_at INTEGER,
  product_type TEXT, has_discount INTEGER DEFAULT 0, created_at INTEGER
)`;

const now = Math.floor(Date.now() / 1000);

// [sku, product_type, has_discount, created_at]
const ROWS: [string, string, number, number][] = [
  ["HW-1", "Home Furnishings > Holiday & Seasonal > Halloween Decorations", 0, now - 400 * 86400],
  ["XM-1", "Home Furnishings > Holiday & Seasonal > Christmas Trees > Artificial", 0, now - 400 * 86400],
  ["XM-2", "Home Furnishings > Holiday & Seasonal > Christmas Decorations > Wreaths", 0, now - 400 * 86400],
  ["LR-1", "Home Furnishings > Living Room Furniture > Sofas", 1, now - 400 * 86400],
  ["BR-1", "Home Furnishings > Bedroom Furniture > Beds", 0, now - 400 * 86400],
  ["OF-1", "Office Products > Office Furniture > Desks", 0, now - 400 * 86400],
  ["PG-1", "Patio & Garden > Patio Furniture > Dining Sets", 1, now - 400 * 86400],
  ["KD-1", "Home Furnishings > Kitchen & Dining Furniture > Bar Stools", 0, now - 400 * 86400],
  ["ST-1", "Home Furnishings > Storage & Organization > Shelving", 0, now - 400 * 86400],
  ["TY-1", "Toys & Games > Outdoor Play > Playhouses", 0, now - 400 * 86400],
  ["PT-1", "Pet Supplies > Dog Supplies > Crates", 0, now - 400 * 86400],
  // Recently imported, and in a branch no fine category claims — so it can only be
  // reached by "nouveautes" or "all".
  ["NEW-1", "Sports & Recreation > Fitness", 0, now - 3 * 86400],
];

describe("category predicates as executable SQL", () => {
  let db: Client;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await db.execute(CREATE_PRODUCTS);
    for (const [sku, type, disc, created] of ROWS) {
      await db.execute({
        sql: `INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [sku, sku, 99, 5, "shop-" + sku, null, type, disc, created],
      });
    }
  });
  afterEach(() => db.close());

  /** Reproduces exactly how getEligibleHighlightCandidates assembles the statement. */
  async function select(key: string): Promise<string[]> {
    const c = getCategory(key)!;
    const extra = c.predicate ? ` AND (${c.predicate})` : "";
    const { rows } = await db.execute({
      sql: `SELECT sku FROM products
            WHERE shopify_product_id IS NOT NULL AND qty > 0
              AND (last_posted_at IS NULL OR last_posted_at < ?)${extra}`,
      args: [now, ...c.args],
    });
    return rows.map((r) => (r as unknown as Record<string, unknown>).sku as string).sort();
  }

  it.each([
    ["all", ROWS.map((r) => r[0]).sort()],
    ["halloween", ["HW-1"]],
    ["noel", ["XM-1", "XM-2"]],
    ["salon", ["LR-1"]],
    ["chambre", ["BR-1"]],
    ["bureau", ["OF-1"]],
    ["exterieur", ["PG-1"]],
    ["cuisine", ["KD-1"]],
    ["rangement", ["ST-1"]],
    ["enfants", ["TY-1"]],
    ["animaux", ["PT-1"]],
    ["solde", ["LR-1", "PG-1"]],
    ["nouveautes", ["NEW-1"]],
  ] as const)("%s selects exactly the right SKUs", async (key, expected) => {
    expect(await select(key)).toEqual([...expected]);
  });

  it("halloween and noel are disjoint despite sharing the Holiday & Seasonal branch", async () => {
    const hw = await select("halloween");
    const xm = await select("noel");
    expect(hw.filter((s) => xm.includes(s))).toEqual([]);
  });

  it("every predicate still honours the base eligibility gate", async () => {
    // Take the patio product out of stock; the category must stop returning it.
    await db.execute(`UPDATE products SET qty = 0 WHERE sku = 'PG-1'`);
    expect(await select("exterieur")).toEqual([]);
    expect(await select("all")).not.toContain("PG-1");
  });

  it("a product posted inside the repost window is excluded whatever the category", async () => {
    await db.execute({
      sql: `UPDATE products SET last_posted_at = ? WHERE sku = 'HW-1'`,
      args: [now + 86400],
    });
    expect(await select("halloween")).toEqual([]);
  });

  it("nouveautes tracks the 30-day window, not import order", async () => {
    await db.execute({
      sql: `UPDATE products SET created_at = ? WHERE sku = 'NEW-1'`,
      args: [now - 45 * 86400],
    });
    expect(await select("nouveautes")).toEqual([]);
  });

  it("no predicate throws — every one is valid SQLite", async () => {
    for (const c of SOCIAL_CATEGORIES) {
      await expect(select(c.key)).resolves.toBeInstanceOf(Array);
    }
  });
});
