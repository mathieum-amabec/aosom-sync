import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({ getProduct: vi.fn() }));
vi.mock("@/lib/image-compositor", () => ({ composeProductImage: vi.fn() }));
vi.mock("@/lib/selectors/shopify-images", () => ({ resolveLifestyle: vi.fn() }));

import { GET } from "@/app/api/image-preview/route";
import { getProduct } from "@/lib/database";
import { composeProductImage } from "@/lib/image-compositor";
import { resolveLifestyle } from "@/lib/selectors/shopify-images";

const req = (qs: string) => new Request(`https://app.test/api/image-preview?${qs}`);
const product = (image1: string) => ({ price: 49.99, image1 }) as never;
const productWithId = (image1: string, shopify_product_id: string) =>
  ({ price: 49.99, image1, shopify_product_id }) as never;

describe("GET /api/image-preview", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the composed PNG on success", async () => {
    vi.mocked(getProduct).mockResolvedValue(product("https://cdn.shopify.com/p.jpg"));
    vi.mocked(composeProductImage).mockResolvedValue(Buffer.from("PNGDATA"));
    const res = await GET(req("sku=ABC&locale=fr&badge=new"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("404s for an unknown sku", async () => {
    vi.mocked(getProduct).mockResolvedValue(null);
    expect((await GET(req("sku=NOPE"))).status).toBe(404);
  });

  it("400s when sku is missing", async () => {
    expect((await GET(req("locale=fr"))).status).toBe(400);
  });

  it("on compose failure, 302-redirects to an allow-listed host", async () => {
    vi.mocked(getProduct).mockResolvedValue(product("https://cdn.shopify.com/files/x.jpg"));
    vi.mocked(composeProductImage).mockRejectedValue(new Error("sharp boom"));
    const res = await GET(req("sku=ABC"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://cdn.shopify.com/files/x.jpg");
  });

  it("on compose failure, redirects for the Aosom CDN host", async () => {
    vi.mocked(getProduct).mockResolvedValue(product("https://img-us.aosomcdn.com/a.jpg"));
    vi.mocked(composeProductImage).mockRejectedValue(new Error("boom"));
    const res = await GET(req("sku=ABC"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://img-us.aosomcdn.com/a.jpg");
  });

  it("refuses to redirect to a non-allow-listed host (502)", async () => {
    vi.mocked(getProduct).mockResolvedValue(product("https://evil.example.com/x.jpg"));
    vi.mocked(composeProductImage).mockRejectedValue(new Error("boom"));
    const res = await GET(req("sku=ABC"));
    expect(res.status).toBe(502);
  });

  it("refuses to redirect to an internal/non-https host (502)", async () => {
    vi.mocked(getProduct).mockResolvedValue(product("http://169.254.169.254/latest/meta-data/"));
    vi.mocked(composeProductImage).mockRejectedValue(new Error("boom"));
    const res = await GET(req("sku=ABC"));
    expect(res.status).toBe(502);
  });

  // ─── lifestyle-aware source ───────────────────────────────────────────
  it("verified product: composes from the Shopify pos-1 photo, NOT the Turso image1", async () => {
    vi.mocked(getProduct).mockResolvedValue(productWithId("https://img-us.aosomcdn.com/whitebg.jpg", "111"));
    vi.mocked(resolveLifestyle).mockResolvedValue({
      verified: true,
      primaryImageUrl: "https://cdn.shopify.com/s/files/lifestyle.jpg",
    });
    vi.mocked(composeProductImage).mockResolvedValue(Buffer.from("PNG"));
    const res = await GET(req("sku=ABC&locale=fr"));
    expect(res.status).toBe(200);
    expect(vi.mocked(composeProductImage).mock.calls[0][0].productImageUrl).toBe(
      "https://cdn.shopify.com/s/files/lifestyle.jpg",
    );
  });

  it("verified but no clean Shopify photo: 404 (never composes the white-bg image1)", async () => {
    vi.mocked(getProduct).mockResolvedValue(productWithId("https://img-us.aosomcdn.com/whitebg.jpg", "111"));
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: true, primaryImageUrl: null });
    const res = await GET(req("sku=ABC"));
    expect(res.status).toBe(404);
    expect(composeProductImage).not.toHaveBeenCalled();
  });

  it("unverified product: falls back to the Turso image1 (dashboard/legacy path)", async () => {
    vi.mocked(getProduct).mockResolvedValue(productWithId("https://cdn.shopify.com/turso.jpg", "111"));
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null });
    vi.mocked(composeProductImage).mockResolvedValue(Buffer.from("PNG"));
    const res = await GET(req("sku=ABC"));
    expect(res.status).toBe(200);
    expect(vi.mocked(composeProductImage).mock.calls[0][0].productImageUrl).toBe("https://cdn.shopify.com/turso.jpg");
  });

  it("img override (allow-listed): composes from it and skips the render-time Shopify lookup", async () => {
    vi.mocked(getProduct).mockResolvedValue(productWithId("https://img-us.aosomcdn.com/whitebg.jpg", "111"));
    vi.mocked(composeProductImage).mockResolvedValue(Buffer.from("PNG"));
    const override = "https://cdn.shopify.com/s/files/pinned.jpg";
    const res = await GET(req(`sku=ABC&img=${encodeURIComponent(override)}`));
    expect(res.status).toBe(200);
    expect(vi.mocked(composeProductImage).mock.calls[0][0].productImageUrl).toBe(override);
    expect(resolveLifestyle).not.toHaveBeenCalled();
  });

  it("img override (non-allow-listed host): ignored, falls through to normal resolution", async () => {
    vi.mocked(getProduct).mockResolvedValue(productWithId("https://cdn.shopify.com/turso.jpg", "111"));
    vi.mocked(resolveLifestyle).mockResolvedValue({ verified: false, primaryImageUrl: null });
    vi.mocked(composeProductImage).mockResolvedValue(Buffer.from("PNG"));
    const res = await GET(req(`sku=ABC&img=${encodeURIComponent("https://evil.example.com/x.jpg")}`));
    expect(res.status).toBe(200);
    expect(vi.mocked(composeProductImage).mock.calls[0][0].productImageUrl).toBe("https://cdn.shopify.com/turso.jpg");
    expect(resolveLifestyle).toHaveBeenCalled();
  });
});
