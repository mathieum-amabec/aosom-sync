/**
 * The 7 public feed routes (Google, Bing, Meta, Meta XML, Pinterest, Pinterest EN, Reddit).
 *
 * They are thin, but they share three invariants that a merchant feed lives or dies on, and
 * all seven ran at 0% coverage:
 *
 *  1. A success is CDN-cached for 10 minutes; **a failure is `no-store`**. Caching a 500
 *     would serve Google an error page for the whole window, from one transient blip.
 *  2. Every outcome is recorded in `feed_syncs` — success with a count, failure with the
 *     message — because that table is the only place a silently-dying feed shows up.
 *  3. The right feed name and the right locale: only `pinterest-en` asks for English items,
 *     and each route records under its own key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/feeds/source", () => ({ getFeedItems: vi.fn() }));
vi.mock("@/lib/database", () => ({ recordFeedSync: vi.fn() }));
vi.mock("@/lib/insights", () => ({ STOREFRONT_BASE_URL: "https://ameublodirect.ca" }));

import { getFeedItems } from "@/lib/feeds/source";
import { recordFeedSync } from "@/lib/database";

import { GET as google } from "@/app/api/feeds/google/route";
import { GET as bing } from "@/app/api/feeds/bing/route";
import { GET as meta } from "@/app/api/feeds/meta/route";
import { GET as metaXml } from "@/app/api/feeds/meta-xml/route";
import { GET as pinterest } from "@/app/api/feeds/pinterest/route";
import { GET as pinterestEn } from "@/app/api/feeds/pinterest-en/route";
import { GET as reddit } from "@/app/api/feeds/reddit/route";

const CACHED = "public, max-age=0, s-maxage=600, stale-while-revalidate=600";

/** [label, handler, feed_syncs key, expected Content-Type prefix] */
const ROUTES: Array<[string, () => Promise<Response>, string, string]> = [
  ["google", google, "google", "application/xml"],
  ["bing", bing, "bing", "application/xml"],
  ["meta", meta, "meta", "application/json"],
  ["meta-xml", metaXml, "meta_xml", "application/xml"],
  ["pinterest", pinterest, "pinterest", "application/xml"],
  ["pinterest-en", pinterestEn, "pinterest_en", "application/xml"],
  ["reddit", reddit, "reddit", "application/xml"],
];

function item(over: Record<string, unknown> = {}) {
  return {
    id: "SKU-1",
    itemGroupId: "7",
    title: "Chaise longue grise",
    description: "Une chaise.",
    link: "https://ameublodirect.ca/products/chaise-longue-grise",
    imageLink: "https://cdn.shopify.com/x.jpg",
    additionalImageLinks: [],
    price: 99.99,
    compareAtPrice: null,
    availability: "in stock",
    condition: "new",
    brand: "Ameublo Direct",
    color: "Gris",
    size: null,
    material: null,
    productType: "Patio & Garden",
    googleCategoryId: 436,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFeedItems).mockResolvedValue([item()] as never);
  vi.mocked(recordFeedSync).mockResolvedValue(undefined as never);
});

describe.each(ROUTES)("GET /api/feeds/%s", (label, handler, key, contentType) => {
  it("serves the feed, CDN-cached, with the right content type", async () => {
    const res = await handler();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(contentType);
    expect(res.headers.get("cache-control")).toBe(CACHED);
    expect(await res.text()).toContain("SKU-1");
  });

  it(`records a success in feed_syncs under "${key}" with the item count`, async () => {
    await handler();

    expect(recordFeedSync).toHaveBeenCalledWith(key, 1, "success");
  });

  it("returns 500 with no-store when the catalogue fetch fails", async () => {
    vi.mocked(getFeedItems).mockRejectedValue(new Error("Shopify products fetch failed: 500"));

    const res = await handler();

    expect(res.status).toBe(500);
    // The important half: a transient failure must not be cached, or Google keeps being
    // handed the error page for the rest of the 10-minute window.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("records the failure and its message, so a dying feed is visible", async () => {
    vi.mocked(getFeedItems).mockRejectedValue(new Error("Shopify products fetch failed: 500"));

    await handler();

    expect(recordFeedSync).toHaveBeenCalledWith(key, null, "error", "Shopify products fetch failed: 500");
  });

  it("serves an empty feed rather than an error when the catalogue is empty", async () => {
    vi.mocked(getFeedItems).mockResolvedValue([] as never);

    const res = await handler();

    expect(res.status).toBe(200);
    expect(recordFeedSync).toHaveBeenCalledWith(key, 0, "success");
  });
});

describe("locale", () => {
  it("only the pinterest-en route asks for English items", async () => {
    for (const [label, handler] of ROUTES) {
      vi.mocked(getFeedItems).mockClear();
      await handler();
      const arg = vi.mocked(getFeedItems).mock.calls[0]?.[0];
      if (label === "pinterest-en") expect(arg).toEqual({ english: true });
      else expect(arg ?? {}).not.toMatchObject({ english: true });
    }
  });
});
