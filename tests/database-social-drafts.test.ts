/**
 * The social-draft fixes of 2026-09-25, run through the REAL exported functions against the
 * REAL schema in an in-memory libsql database (same approach as database-morning-report.test.ts):
 *  - editorial drafts never get the placeholder product joined (the "Adirondack chair" label);
 *  - editorial + stock-highlight drafts now expire like new_product ones;
 *  - the repost cooldown covers the whole Shopify fiche, not just the posted colour.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let mod: typeof import("@/lib/database");

beforeAll(async () => {
  mod = await import("@/lib/database");
  db = await mod.ensureSchema();
});

beforeEach(async () => {
  await db.execute(`DELETE FROM facebook_drafts`);
  await db.execute(`DELETE FROM products`);
  await db.execute(`INSERT INTO products (sku, name, image1, qty, shopify_product_id) VALUES
    ('01-0016', 'Classic Adirondack Chair Muskoka Chair', 'https://cdn/chair.jpg', 0, NULL),
    ('84A-148BK', 'Patio Glider Black', 'https://cdn/glider-bk.jpg', 5, 'P1'),
    ('84A-148BU', 'Patio Glider Blue', 'https://cdn/glider-bu.jpg', 5, 'P1'),
    ('84A-148LG', 'Patio Glider Grey', 'https://cdn/glider-lg.jpg', 5, 'P1'),
    ('900-001', 'Other product', 'https://cdn/other.jpg', 5, 'P2'),
    ('ORPHAN', 'Not imported', 'https://cdn/orphan.jpg', 5, NULL)`);
});

const draft = (sku: string, triggerType: string, over: Record<string, unknown> = {}) =>
  mod.createFacebookDraft({ sku, triggerType, language: "fr", postText: `post ${triggerType}`, ...over } as never);

describe("draft reads never join the placeholder product onto an editorial post", () => {
  it("getFacebookDrafts / getFacebookDraft / getDraftsForReview", async () => {
    const editorial = await draft("01-0016", "content_template");
    const product = await draft("84A-148BK", "stock_highlight");

    const list = await mod.getFacebookDrafts({ limit: 10 });
    const byId = new Map(list.map((d) => [d.id, d]));
    expect(byId.get(editorial)!.productName).toBeUndefined();
    expect(byId.get(editorial)!.productImage).toBeUndefined();
    expect(byId.get(product)!.productName).toBe("Patio Glider Black");
    expect(byId.get(product)!.productImage).toBe("https://cdn/glider-bk.jpg");

    expect((await mod.getFacebookDraft(editorial))!.productImage).toBeUndefined();
    expect((await mod.getFacebookDraft(product))!.productName).toBe("Patio Glider Black");

    const page = await mod.getDraftsForReview({ statuses: ["draft"] });
    expect(page.items.find((d) => d.id === editorial)!.productName).toBeUndefined();
  });
});

describe("expireStaleDrafts", () => {
  const age = async (id: number, days: number) =>
    db.execute({ sql: `UPDATE facebook_drafts SET created_at = unixepoch() - 86400 * ? WHERE id = ?`, args: [days, id] });

  it("expires each trigger past its own TTL, only unapproved drafts", async () => {
    const oldNew = await draft("900-001", "new_product"); await age(oldNew, 8);
    const oldEditorial = await draft("01-0016", "content_template"); await age(oldEditorial, 15);
    const youngEditorial = await draft("01-0016", "content_template"); await age(youngEditorial, 10);
    const oldHighlight = await draft("84A-148BK", "stock_highlight"); await age(oldHighlight, 20);
    const approvedOld = await draft("01-0016", "content_template"); await age(approvedOld, 60);
    await db.execute({ sql: `UPDATE facebook_drafts SET status = 'approved' WHERE id = ?`, args: [approvedOld] });
    const oldPriceDrop = await draft("900-001", "price_drop"); await age(oldPriceDrop, 60);

    const n = await mod.expireStaleDrafts({ new_product: 7, content_template: 14, stock_highlight: 14 });
    expect(n).toBe(3);

    const rows = await db.execute(`SELECT id, status, reviewed_by, review_notes FROM facebook_drafts`);
    const st = new Map(rows.rows.map((r) => [Number(r.id), r]));
    expect(st.get(oldNew)!.status).toBe("rejected");
    expect(st.get(oldEditorial)!.status).toBe("rejected");
    expect(st.get(oldEditorial)!.review_notes).toBe("Auto-expiré: content_template >14j");
    expect(st.get(oldEditorial)!.reviewed_by).toBe("auto-ttl");
    expect(st.get(oldHighlight)!.status).toBe("rejected");
    expect(st.get(youngEditorial)!.status).toBe("draft"); // 10 d < 14 d
    expect(st.get(approvedOld)!.status).toBe("approved"); // approved/queued never touched
    expect(st.get(oldPriceDrop)!.status).toBe("draft"); // trigger not in the TTL map
  });

  it("expireStaleNewProductDrafts keeps its original behaviour", async () => {
    const oldNew = await draft("900-001", "new_product"); await age(oldNew, 8);
    const oldEditorial = await draft("01-0016", "content_template"); await age(oldEditorial, 30);
    expect(await mod.expireStaleNewProductDrafts(7)).toBe(1);
  });
});

describe("markProductPosted — cooldown for the whole fiche", () => {
  const posted = async () =>
    new Map((await db.execute(`SELECT sku, last_posted_at FROM products`)).rows.map((r) => [String(r.sku), r.last_posted_at]));

  it("marks every colour of the same Shopify product, and nothing else", async () => {
    await mod.markProductPosted("84A-148BK");
    const p = await posted();
    expect(p.get("84A-148BK")).not.toBeNull();
    expect(p.get("84A-148BU")).not.toBeNull();
    expect(p.get("84A-148LG")).not.toBeNull();
    expect(p.get("900-001")).toBeNull();
    expect(p.get("01-0016")).toBeNull();
    expect(p.get("ORPHAN")).toBeNull();
  });

  it("a SKU with no Shopify product marks only itself (never every NULL-product row)", async () => {
    await mod.markProductPosted("ORPHAN");
    const p = await posted();
    expect(p.get("ORPHAN")).not.toBeNull();
    expect(p.get("01-0016")).toBeNull(); // also has shopify_product_id NULL — must not be swept in
    expect(p.get("84A-148BK")).toBeNull();
  });

  it("siblings of a just-posted colour drop out of the highlight candidates", async () => {
    await mod.markProductPosted("84A-148BK");
    const cands = await mod.getEligibleHighlightCandidates(30, 50);
    const skus = cands.map((c) => String(c.sku));
    expect(skus).toEqual(["900-001"]);
  });
});

describe("cooldown release — only LIVE drafts hold a fiche's cooldown", () => {
  const postedAt = async (sku: string) =>
    (await db.execute({ sql: `SELECT last_posted_at FROM products WHERE sku = ?`, args: [sku] })).rows[0].last_posted_at;
  // A highlight on the black glider: draft created + whole fiche P1 marked (as job4 does).
  const highlight = async (sku = "84A-148BK") => {
    const id = await draft(sku, "stock_highlight");
    await mod.markProductPosted(sku);
    return id;
  };

  it("rejecting (/drafts page) frees every colour of the fiche", async () => {
    const id = await highlight();
    expect(await postedAt("84A-148BU")).not.toBeNull();
    await mod.rejectDraftDb(id, "pas bon");
    expect(await postedAt("84A-148BK")).toBeNull();
    expect(await postedAt("84A-148BU")).toBeNull();
  });

  it("rejecting via /api/social (updateFacebookDraft status=rejected) frees it too", async () => {
    const id = await highlight();
    await mod.updateFacebookDraft(id, { status: "rejected" });
    expect(await postedAt("84A-148LG")).toBeNull();
  });

  it("a non-reject update never touches the cooldown", async () => {
    const id = await highlight();
    await mod.updateFacebookDraft(id, { post_text: "edited" });
    expect(await postedAt("84A-148BK")).not.toBeNull();
  });

  it("deleting a draft frees it", async () => {
    const id = await highlight();
    await mod.deleteFacebookDraft(id);
    expect(await postedAt("84A-148BK")).toBeNull();
  });

  it("another LIVE draft on the same fiche keeps it locked, at that draft's date", async () => {
    const rejected = await highlight("84A-148BK");
    const live = await draft("84A-148BU", "stock_highlight");
    await db.execute({ sql: `UPDATE facebook_drafts SET created_at = 1700000000 WHERE id = ?`, args: [live] });
    await mod.rejectDraftDb(rejected, "x");
    expect(Number(await postedAt("84A-148BK"))).toBe(1700000000);
    expect(Number(await postedAt("84A-148LG"))).toBe(1700000000);
  });

  it("an editorial draft on the placeholder sku never holds a product cooldown", async () => {
    const id = await draft("01-0016", "content_template");
    await mod.recomputeProductCooldown(["01-0016"]);
    expect(await postedAt("01-0016")).toBeNull();
    await mod.rejectDraftDb(id, "x");
    expect(await postedAt("01-0016")).toBeNull();
  });

  it("TTL expiry frees the products of the drafts it expires", async () => {
    const id = await highlight();
    await db.execute({ sql: `UPDATE facebook_drafts SET created_at = unixepoch() - 86400 * 20 WHERE id = ?`, args: [id] });
    expect(await mod.expireStaleDrafts({ stock_highlight: 14 })).toBe(1);
    expect(await postedAt("84A-148BU")).toBeNull();
  });

  it("recomputeAllProductCooldowns releases fiches whose drafts were rejected before this rule", async () => {
    const id = await highlight();
    // Rejected the OLD way (raw status write, no release) — the state production is in today.
    await db.execute({ sql: `UPDATE facebook_drafts SET status = 'rejected' WHERE id = ?`, args: [id] });
    const keep = await highlight("900-001");
    expect(keep).toBeGreaterThan(0);
    expect(await mod.recomputeAllProductCooldowns()).toBeGreaterThanOrEqual(3);
    expect(await postedAt("84A-148BK")).toBeNull();
    expect(await postedAt("84A-148LG")).toBeNull();
    expect(await postedAt("900-001")).not.toBeNull(); // its draft is still live
  });

  it("nextHighlightAvailableAt = oldest cooling product of the pool + cooldown", async () => {
    await db.execute(`UPDATE products SET last_posted_at = unixepoch() - 86400 * 5 WHERE sku = '84A-148BK'`);
    await db.execute(`UPDATE products SET last_posted_at = unixepoch() - 86400 * 2 WHERE sku = '900-001'`);
    const t = await mod.nextHighlightAvailableAt(7);
    const now = Math.floor(Date.now() / 1000);
    expect(t! - now).toBeGreaterThan(86400 * 2 - 5);
    expect(t! - now).toBeLessThan(86400 * 2 + 5); // 5 days ago + 7 days = in 2 days
    expect(await mod.nextHighlightAvailableAt(7, { predicate: "sku = ?", args: ["ORPHAN"] })).toBeNull();
  });
});
