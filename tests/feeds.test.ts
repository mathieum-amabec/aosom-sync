import { describe, it, expect } from "vitest";
import { mapToGoogleCategory, DEFAULT_GOOGLE_CATEGORY } from "@/lib/feeds/google-category";
import {
  escapeXml, stripHtml, truncate, formatPrice,
  buildGoogleFeed, buildPinterestFeed, buildMetaFeed, buildMetaXmlFeed, type FeedItem,
} from "@/lib/feeds/feed";
import { shopifyToFeedItems, type ShopifyFeedProduct } from "@/lib/feeds/source";

describe("mapToGoogleCategory", () => {
  const cases: Array<[string, number]> = [
    ["Pet Supplies > Cats > Outdoor Cat Enclosures", 1],          // pet beats "outdoor"
    ["Patio & Garden > BBQs & Grills > Propane Gas Grills", 3553], // bbq
    ["Toys & Games > Baby & Toddler Toys > Electric Toy Cars", 220],
    ["Patio & Garden > Lawn & Garden > Raised Garden Beds > Galvanized Planter Boxes", 2962], // garden beats "patio"
    ["Patio & Garden > Patio Furniture > Patio Furniture Sets", 6792], // outdoor furniture
    ["Patio & Garden > Sun Loungers > Lounger Chairs", 6792],
    ["Home Furnishings > Kitchen & Dining Furniture > Bar Stools", 436],
    ["Office Products > Office Furniture > Office Chairs > Task Chairs", 436],
    ["Gazebo", 6792],          // short Shopify type
    ["Greenhouse", 2962],      // short Shopify type
    ["Garden Pathway", 2962],  // short Shopify type
  ];
  for (const [pt, id] of cases) {
    it(`maps "${pt.split(">").pop()?.trim()}" → ${id}`, () => {
      expect(mapToGoogleCategory(pt).id).toBe(id);
    });
  }
  it("falls back to the default for empty/unknown", () => {
    expect(mapToGoogleCategory("").id).toBe(DEFAULT_GOOGLE_CATEGORY.id);
    expect(mapToGoogleCategory(null).id).toBe(DEFAULT_GOOGLE_CATEGORY.id);
    expect(mapToGoogleCategory("Totally Unknown Thing").id).toBe(436);
  });
});

describe("text helpers", () => {
  it("escapeXml escapes the 5 entities", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });
  it("stripHtml removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello&nbsp; <b>world</b></p>\n\n  !")).toBe("Hello world !");
  });
  it("truncate keeps short strings and ellipsizes long ones", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
  it("formatPrice yields '<amount> CAD'", () => {
    expect(formatPrice(41.9)).toBe("41.90 CAD");
    expect(formatPrice(0)).toBe("0.00 CAD");
  });
  it("escapeXml/stripHtml strip XML-forbidden control chars (one bad byte must not poison the feed)", () => {
    const ctrl = String.fromCharCode(1); // 0x01 — illegal in XML 1.0
    expect(escapeXml("abc" + ctrl + "d")).toBe("abcd");
    expect(stripHtml("x" + ctrl + "y")).toBe("xy");
  });
  it("truncate does not split an astral emoji into a lone surrogate", () => {
    const out = truncate("😀".repeat(5), 3);
    expect([...out].every((ch) => ch === "😀" || ch === "…")).toBe(true);
  });
});

const fixtureProducts: ShopifyFeedProduct[] = [
  {
    id: 111, title: "Chaise de patio", handle: "chaise-de-patio", vendor: "Outsunny",
    status: "active", product_type: "Patio & Garden > Patio Furniture > Patio Chairs",
    body_html: "<p>Une <b>belle</b> chaise</p>",
    images: [{ src: "https://img/1.jpg" }, { src: "https://img/2.jpg" }],
    variants: [
      { sku: "PAT-001GY", price: "129.99", inventory_management: null, title: "Gris" },
      { sku: "PAT-001BK", price: "129.99", inventory_management: "shopify", inventory_quantity: 0, title: "Noir" },
    ],
  },
  { id: 222, title: "Brouillon", handle: "brouillon", status: "draft", images: [{ src: "x" }], variants: [{ sku: "D1", price: "10" }] }, // draft → skipped
  { id: 333, title: "Sans image", handle: "sans-image", status: "active", images: [], variants: [{ sku: "N1", price: "10" }] }, // no image → skipped
  { id: 444, title: "Prix zéro", handle: "px0", status: "active", images: [{ src: "y" }], variants: [{ sku: "Z1", price: "0" }] }, // price 0 → skipped
];

describe("shopifyToFeedItems", () => {
  const items = shopifyToFeedItems(fixtureProducts);

  it("emits one item per priced variant of ACTIVE products with an image", () => {
    expect(items.map((i) => i.id).sort()).toEqual(["PAT-001BK", "PAT-001GY"]);
  });
  it("skips draft, imageless, and zero-price products", () => {
    expect(items.find((i) => i.id === "D1")).toBeUndefined();
    expect(items.find((i) => i.id === "N1")).toBeUndefined();
    expect(items.find((i) => i.id === "Z1")).toBeUndefined();
  });
  it("builds storefront links, brand, category, and groups variants", () => {
    const gy = items.find((i) => i.id === "PAT-001GY")!;
    expect(gy.link).toBe("https://ameublodirect.ca/products/chaise-de-patio");
    expect(gy.brand).toBe("Outsunny");
    expect(gy.googleCategoryId).toBe(6792);
    expect(gy.itemGroupId).toBe("111");
    expect(gy.title).toContain("Chaise de patio");
    expect(gy.imageLink).toBe("https://img/1.jpg");
    expect(gy.additionalImageLinks).toEqual(["https://img/2.jpg"]);
    expect(gy.description).toBe("Une belle chaise");
  });
  it("treats untracked variants as in stock and tracked-zero as out of stock", () => {
    expect(items.find((i) => i.id === "PAT-001GY")!.availability).toBe("in stock");
    expect(items.find((i) => i.id === "PAT-001BK")!.availability).toBe("out of stock");
  });
  it("defaults brand to Aosom when vendor is missing", () => {
    const noVendor = shopifyToFeedItems([{ ...fixtureProducts[0], id: 9, vendor: null, handle: "h", variants: [{ sku: "S", price: "5", inventory_management: null }] }]);
    expect(noVendor[0].brand).toBe("Aosom");
  });
  it("deduplicates g:id (SKU) across the whole feed", () => {
    const dup = shopifyToFeedItems([
      { id: 1, title: "A", handle: "a", status: "active", images: [{ src: "i" }], variants: [{ sku: "SAME", price: "10", inventory_management: null }] },
      { id: 2, title: "B", handle: "b", status: "active", images: [{ src: "i" }], variants: [{ sku: "SAME", price: "20", inventory_management: null }] },
    ]);
    expect(dup.map((i) => i.id)).toEqual(["SAME"]); // only the first wins
  });
});

describe("shopifyToFeedItems — preferEnglishTitle (Pinterest EN feed)", () => {
  const enProducts: ShopifyFeedProduct[] = [
    {
      id: 700, title: "Chaise de patio", titleEn: "Patio Chair", handle: "chaise-de-patio",
      vendor: "Outsunny", status: "active",
      product_type: "Patio & Garden > Patio Furniture > Patio Chairs",
      images: [{ src: "https://img/1.jpg" }],
      variants: [{ sku: "EN-001", price: "129.99", inventory_management: null }],
    },
    {
      id: 701, title: "Niche pour chien", titleEn: "  ", handle: "niche", status: "active", // blank EN → fallback
      images: [{ src: "https://img/2.jpg" }],
      variants: [{ sku: "EN-002", price: "59.99", inventory_management: null }],
    },
    {
      id: 702, title: "Tente de jardin", handle: "tente", status: "active", // no EN at all → fallback
      images: [{ src: "https://img/3.jpg" }],
      variants: [{ sku: "EN-003", price: "89.99", inventory_management: null }],
    },
  ];

  it("uses custom.title_en when present", () => {
    const items = shopifyToFeedItems(enProducts, { preferEnglishTitle: true });
    expect(items.find((i) => i.id === "EN-001")!.title).toBe("Patio Chair");
  });
  it("falls back to the FR title when title_en is blank or absent", () => {
    const items = shopifyToFeedItems(enProducts, { preferEnglishTitle: true });
    expect(items.find((i) => i.id === "EN-002")!.title).toBe("Niche pour chien");
    expect(items.find((i) => i.id === "EN-003")!.title).toBe("Tente de jardin");
  });
  it("ignores title_en when preferEnglishTitle is not set (FR feed default)", () => {
    const items = shopifyToFeedItems(enProducts);
    expect(items.find((i) => i.id === "EN-001")!.title).toBe("Chaise de patio");
  });
});

const sample: FeedItem[] = shopifyToFeedItems(fixtureProducts);

describe("buildGoogleFeed", () => {
  const xml = buildGoogleFeed(sample, { title: "T & Co", link: "https://x", description: "d" });
  it("is well-formed RSS with the g: namespace and channel title escaped", () => {
    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`xmlns:g="http://base.google.com/ns/1.0"`);
    expect(xml).toContain(`<title>T &amp; Co</title>`);
  });
  it("emits required g: fields per item", () => {
    expect(xml).toContain("<g:id>PAT-001GY</g:id>");
    expect(xml).toContain("<g:price>129.99 CAD</g:price>");
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:condition>new</g:condition>");
    expect(xml).toContain("<g:brand>Outsunny</g:brand>");
    expect(xml).toContain("<g:google_product_category>6792</g:google_product_category>");
    expect(xml).toContain("<g:item_group_id>111</g:item_group_id>");
    expect(xml).toContain("<g:additional_image_link>https://img/2.jpg</g:additional_image_link>");
  });
  it("contains exactly one <item> per feed item", () => {
    expect((xml.match(/<item>/g) || []).length).toBe(sample.length);
  });
});

describe("buildPinterestFeed", () => {
  it("produces RSS with additional_image_link for extra images", () => {
    const xml = buildPinterestFeed(sample, { title: "P", link: "https://x", description: "d" });
    expect(xml).toContain(`xmlns:g="http://base.google.com/ns/1.0"`);
    expect(xml).toContain("<g:additional_image_link>https://img/2.jpg</g:additional_image_link>");
  });
});

describe("buildMetaFeed", () => {
  const json = buildMetaFeed(sample);
  it("returns Meta catalog objects with the required fields", () => {
    const it0 = json.find((j) => j.id === "PAT-001GY")!;
    expect(it0).toMatchObject({
      id: "PAT-001GY", availability: "in stock", condition: "new",
      price: "129.99 CAD", link: "https://ameublodirect.ca/products/chaise-de-patio",
      image_link: "https://img/1.jpg", brand: "Outsunny", google_product_category: 6792,
      additional_image_link: "https://img/2.jpg", item_group_id: "111",
    });
  });
  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

// Sale-price fixture: a product whose variant has a compare_at_price (regular > current).
const saleProducts: ShopifyFeedProduct[] = [
  {
    id: 555, title: "Parasol en solde", handle: "parasol", vendor: "Outsunny", status: "active",
    product_type: "Patio & Garden > Patio Shade > Patio Umbrellas",
    images: [{ src: "https://img/p.jpg" }],
    variants: [
      { sku: "UMB-1", price: "79.99", compare_at_price: "129.99", inventory_management: null },   // on sale
      { sku: "UMB-2", price: "79.99", compare_at_price: "50.00", inventory_management: null },      // compare <= price → not a sale
    ],
  },
];

describe("shopifyToFeedItems — compareAtPrice", () => {
  const items = shopifyToFeedItems(saleProducts);
  it("captures compare_at_price only when it exceeds the current price", () => {
    expect(items.find((i) => i.id === "UMB-1")!.compareAtPrice).toBe(129.99);
    expect(items.find((i) => i.id === "UMB-2")!.compareAtPrice).toBeNull();
  });
});

describe("buildMetaXmlFeed", () => {
  const items = shopifyToFeedItems([...fixtureProducts, ...saleProducts]);
  const xml = buildMetaXmlFeed(items, { title: "Meta", link: "https://x", description: "d" });

  it("is RSS 2.0 with the g: namespace", () => {
    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`xmlns:g="http://base.google.com/ns/1.0"`);
  });
  it("adds g:custom_label_0 = product_type", () => {
    expect(xml).toContain("<g:custom_label_0>Patio &amp; Garden &gt; Patio Furniture &gt; Patio Chairs</g:custom_label_0>");
  });
  it("emits g:sale_price (current) + g:price (regular) for a discounted item", () => {
    const block = xml.split("<item>").find((b) => b.includes("<g:id>UMB-1</g:id>"))!;
    expect(block).toContain("<g:price>129.99 CAD</g:price>");      // regular = compare_at
    expect(block).toContain("<g:sale_price>79.99 CAD</g:sale_price>"); // current
  });
  it("omits g:sale_price when there is no real discount", () => {
    const block = xml.split("<item>").find((b) => b.includes("<g:id>PAT-001GY</g:id>"))!;
    expect(block).toContain("<g:price>129.99 CAD</g:price>");
    expect(block).not.toContain("<g:sale_price>");
  });
});
