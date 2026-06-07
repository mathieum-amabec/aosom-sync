import { describe, it, expect } from "vitest";
import { localizeBrandedImageUrls } from "@/lib/social-publisher";

const BRANDED = "https://app.example.com/api/image-preview?sku=ABC-1&locale=fr&price=129.99&badge=new";
const RAW = "https://cdn.aosom.ca/products/abc-1.jpg";

describe("localizeBrandedImageUrls", () => {
  it("rewrites the branded image-preview locale to 'en' for EN channels", () => {
    const [branded, raw] = localizeBrandedImageUrls([BRANDED, RAW], "EN");
    const u = new URL(branded);
    expect(u.searchParams.get("locale")).toBe("en");
    expect(u.searchParams.get("sku")).toBe("ABC-1");   // other params preserved
    expect(u.searchParams.get("price")).toBe("129.99");
    expect(u.searchParams.get("badge")).toBe("new");
    expect(raw).toBe(RAW);                              // raw product photo untouched
  });

  it("keeps the branded locale 'fr' for FR channels", () => {
    const [branded] = localizeBrandedImageUrls([BRANDED], "FR");
    expect(new URL(branded).searchParams.get("locale")).toBe("fr");
  });

  it("leaves non image-preview URLs untouched (even with a locale param)", () => {
    const other = "https://x.com/img?locale=fr";
    expect(localizeBrandedImageUrls([other], "EN")).toEqual([other]);
  });

  it("leaves an image-preview URL without a locale param untouched", () => {
    const noLocale = "https://app.example.com/api/image-preview?sku=ABC-1&price=10";
    const out = localizeBrandedImageUrls([noLocale], "EN")[0];
    expect(new URL(out).searchParams.has("locale")).toBe(false);
  });

  it("passes through relative / non-absolute URLs without throwing", () => {
    expect(localizeBrandedImageUrls(["/api/image-preview?locale=fr", ""], "EN"))
      .toEqual(["/api/image-preview?locale=fr", ""]);
  });

  it("handles an empty list", () => {
    expect(localizeBrandedImageUrls([], "EN")).toEqual([]);
  });
});
