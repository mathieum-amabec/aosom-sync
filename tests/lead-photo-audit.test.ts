import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/database", () => ({ getCachedImageStyles: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/feeds/source", () => ({ fetchShopifyFeedProducts: vi.fn() }));
const { runLeadPhotoAudit, NEW_DAYS } = await import("@/lib/lead-photo-audit");
const { imageUrlStem } = await import("@/lib/image-compliance-audit");
import type { ShopifyFeedProduct } from "@/lib/feeds/source";
import type { AdImageStyle } from "@/lib/image-style";

const NOW = new Date("2026-11-20T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const src = (n: string) => `https://cdn.shopify.com/s/files/1/0/${n}.jpg`;

function product(handle: string, created: string, photos: string[], over: Partial<ShopifyFeedProduct> = {}): ShopifyFeedProduct {
  return { id: handle, title: handle, handle, status: "active", created_at: created, images: photos.map((p, i) => ({ id: i + 1, src: src(p) })), variants: [{ sku: handle, price: "10" }], ...over };
}
const run = (products: ShopifyFeedProduct[], style: Record<string, AdImageStyle>) =>
  runLeadPhotoAudit({
    products: async () => products,
    styles: async () => new Map(Object.entries(style).map(([k, v]) => [imageUrlStem(src(k)), v])),
    now: () => NOW,
  });

describe("runLeadPhotoAudit", () => {
  it("a recent import that leads with a packshot while a lifestyle exists is red", async () => {
    const r = await run([product("new-bad", daysAgo(2), ["a", "b"])], { a: "studio", b: "lifestyle" });
    expect(r.ok).toBe(false);
    expect(r.newFixable).toBe(1);
    expect(r.reasons[0]).toContain("new-bad");
  });

  it("the old backlog is counted but is NOT an alert", async () => {
    const r = await run([product("old-bad", daysAgo(NEW_DAYS + 5), ["a", "b"])], { a: "studio", b: "lifestyle" });
    expect(r.ok).toBe(true);
    expect(r.fixable).toBe(1);
    expect(r.newFixable).toBe(0);
  });

  it("a packshot lead with no lifestyle anywhere is not fixable, and an uncached style is unknown, never a defect", async () => {
    const r = await run([
      product("no-alt", daysAgo(1), ["a", "b"]),
      product("uncached", daysAgo(1), ["x", "b"]),
      product("good", daysAgo(1), ["l", "a"]),
    ], { a: "studio", b: "studio", l: "lifestyle" });
    expect(r.ok).toBe(true);
    expect(r.fixable).toBe(0);
    expect(r.galleryLead).toEqual({ lifestyle: 1, studio: 1, unknown: 1 });
  });

  it("the page lead is the default variant's own photo when it has one", async () => {
    const p = product("colour", daysAgo(30), ["l", "pack"], { variants: [{ sku: "c", price: "1", image_id: 2 }] });
    const r = await run([p], { l: "lifestyle", pack: "studio" });
    expect(r.galleryLead.lifestyle).toBe(1);
    expect(r.pageLead.studio).toBe(1);
  });

  it("ignores drafts and products without photos", async () => {
    const r = await run([product("d", daysAgo(1), ["a", "b"], { status: "draft" }), product("n", daysAgo(1), [])], { a: "studio", b: "lifestyle" });
    expect(r.products).toBe(0);
  });
});
