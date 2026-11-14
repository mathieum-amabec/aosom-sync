import { describe, it, expect, vi, beforeEach } from "vitest";

const shopifyFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/shopify-client", () => ({ shopifyFetch }));

import { htmlToText, getProductDetails, __clearProductDetailsCache } from "@/lib/product-details";

const ok = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  shopifyFetch.mockReset();
  __clearProductDetailsCache();
});

describe("product details for the assistant (get_product_details)", () => {
  it("turns description HTML into readable text, list items and table cells kept", () => {
    const t = htmlToText("<h3>Dimensions</h3><ul><li>Largeur : 84 po</li><li>Profondeur : 35 po</li></ul><table><tr><td>Poids max</td><td>300 lb</td></tr></table><script>x()</script>");
    expect(t).toContain("- Largeur : 84 po");
    expect(t).toContain("Poids max | 300 lb");
    expect(t).not.toContain("x()");
  });

  it("returns FR title, description, options and variants by handle", async () => {
    shopifyFetch.mockResolvedValue(ok({ products: [{ id: 1, title: "Abri auto", body_html: "<p>Assemblage requis</p>", options: [{ name: "Taille", values: ["10 x 15 pi", "11 x 15 pi"] }], variants: [{ title: "10 x 15 pi", price: "698.99" }] }] }));
    const d = await getProductDetails("abri-auto", "fr");
    expect(d).toEqual({ title: "Abri auto", description: "Assemblage requis", options: ["Taille: 10 x 15 pi, 11 x 15 pi"], variants: [{ label: "10 x 15 pi", price: "698.99" }] });
    expect(shopifyFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the EN metafield description for the English site", async () => {
    shopifyFetch
      .mockResolvedValueOnce(ok({ products: [{ id: 7, title: "Abri auto", body_html: "<p>FR</p>", options: [], variants: [] }] }))
      .mockResolvedValueOnce(ok({ metafields: [{ value: "<p>Assembly required</p>" }] }));
    expect((await getProductDetails("abri-auto", "en"))?.description).toBe("Assembly required");
  });

  it("does not cache a network failure", async () => {
    shopifyFetch.mockRejectedValueOnce(new Error("down")).mockResolvedValue(ok({ products: [{ id: 1, title: "T", body_html: "", options: [], variants: [] }] }));
    expect(await getProductDetails("h", "fr")).toBeNull();
    expect((await getProductDetails("h", "fr"))?.title).toBe("T");
  });
});
