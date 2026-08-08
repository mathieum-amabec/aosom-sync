import { describe, it, expect } from "vitest";
import { mapToGoogleCategory, DEFAULT_GOOGLE_CATEGORY } from "@/lib/feeds/google-category";
import {
  escapeXml, stripHtml, truncate, formatPrice,
  buildGoogleFeed, buildPinterestFeed, buildMetaFeed, buildMetaXmlFeed,
  buildBingFeed, buildRedditFeed, saleSplit, salePriceEffectiveDate, availabilityValue, type FeedItem,
} from "@/lib/feeds/feed";
import { shopifyToFeedItems, stripImperialDimensions, stripPromoText, frenchifyColor, optionValue, materialFromMetafields, MATERIAL_METAFIELD_KEYS, type ShopifyFeedProduct } from "@/lib/feeds/source";

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

describe("stripImperialDimensions", () => {
  // Real shapes pulled from the live Google feed (FR title + trailing variant size).
  const strips: Array<[string, string]> = [
    // 3-axis with W/D/H letters (spaced and unspaced)
    ["Tables de chevet 2 pièces - Noir / 15.7\" W x 11.8\" D x 19.3\" H", "Tables de chevet 2 pièces - Noir"],
    ["Table de toilettage - Noir / 43\"L x 23.5\"W x 64.6\"H", "Table de toilettage - Noir"],
    // 2- and 3-axis with no letters
    ["Armoire pharmacie murale miroir 71 x 61 cm - White / 28\" x 24\"", "Armoire pharmacie murale miroir 71 x 61 cm - White"],
    ["Canapé 2 places - Crème / 55.5\" x 27.6\" x 30.7\"", "Canapé 2 places - Crème"],
    // single measurement that carries a dimension letter
    ["Canapé 3 places en lin - Beige / 75\" W", "Canapé 3 places en lin - Beige"],
    // L/W/H ordering, spaced
    ["Voiture électrique 24V - Bleu / 47.2\" L x 31.5\" W x 29.5\" H", "Voiture électrique 24V - Bleu"],
    // unicode × separator
    ["Bureau - Noir / 28\" × 24\" × 44.9\"", "Bureau - Noir"],
    // dims directly after the color separator (no slash) — trailing " - " must be cleaned
    ["Étagère compacte - 30\" W x 12\" D", "Étagère compacte"],
    // width-only single bare inch after the " / " variant delimiter
    ["Table à manger 119 cm - Noir / 47\"", "Table à manger 119 cm - Noir"],
    ["Barrière pour animaux 76-131 cm - Blanc / 30\"", "Barrière pour animaux 76-131 cm - Blanc"],
    // adjustable range on the last axis (spaced and unspaced hyphen) — must strip the whole block
    ["Chaise massage inclinable - Beige / 26.5\" W x 28.25\" D x 43.75\"-46.75\" H", "Chaise massage inclinable - Beige"],
    ["Chaise sans bras réglable - Noir / 22.8\" W x 22\" D x 26.8\" -29.9\" H", "Chaise sans bras réglable - Noir"],
    ["Tabourets de bar ajustables - Gris / 18.1\" x 19.7\" x 33.5\" -41.7\"", "Tabourets de bar ajustables - Gris"],
  ];
  for (const [input, expected] of strips) {
    it(`strips: ${input}`, () => expect(stripImperialDimensions(input)).toBe(expected));
  }

  describe("stripPromoText", () => {
    // Every phrasing below was pulled verbatim from a live Google-feed description on
    // 2026-08-06 (18 items carried one). Google prohibits promotional text in title and
    // description, so none of these may survive into the feed.
    const strips: Array<[string, string]> = [
      ["Instructions incluses pour un montage simple Livraison gratuite partout au Canada!", "Instructions incluses pour un montage simple"],
      ["…zone de plantation : 168 x 85 x 30 cm Livraison gratuite partout au Canada Matériaux : Acier galvanisé", "…zone de plantation : 168 x 85 x 30 cm Matériaux : Acier galvanisé"],
      ["Table 73 x 65 x 32 cm Livraison gratuite partout au Canada. Assemblage requis.", "Table 73 x 65 x 32 cm Assemblage requis."],
      ["Assemblage requis. Livraison gratuite partout au Canada.", "Assemblage requis."],
      ["espace piscine Livraison gratuite au Canada. Assemblage requis.", "espace piscine Assemblage requis."],
      ["idéale pour les patios et jardins Livraison gratuite - Partout au Canada Spécifications techniques :", "idéale pour les patios et jardins Spécifications techniques :"],
      ["surface stable (béton, bois) Livraison gratuite disponible. Créez votre oasis", "surface stable (béton, bois) Créez votre oasis"],
      ["à longueur d'année Livraison gratuite partout au Canada ! Commencez votre jardin", "à longueur d'année Commencez votre jardin"],
      // English equivalent — the EN feed (pinterest-en) must be covered too.
      ["Assembly required. Free shipping across Canada!", "Assembly required."],
      ["Sturdy steel frame Free shipping available. Built to last", "Sturdy steel frame Built to last"],
    ];
    for (const [input, expected] of strips) {
      it(`strips: ${input.slice(0, 60)}…`, () => expect(stripPromoText(input)).toBe(expected));
    }

    // Conservative: legitimate copy that merely mentions delivery must survive intact.
    const keeps = [
      "Livraison en 3 à 5 jours ouvrables",              // delivery info, not a free-shipping claim
      "Frais de livraison calculés à la caisse",          // explicitly NOT free
      "Poignée de transport gratuite incluse",            // "gratuite" unrelated to shipping
      "Shipping weight: 12 kg",                           // spec line, not a claim
      "Assemblage requis. Instructions incluses.",        // no promo at all
    ];
    for (const input of keeps) {
      it(`keeps: ${input}`, () => expect(stripPromoText(input)).toBe(input));
    }

    it("is idempotent", () => {
      const once = stripPromoText("Montage simple Livraison gratuite partout au Canada!");
      expect(stripPromoText(once)).toBe(once);
    });
  });

  // Conservative: must NOT strip when there's no unambiguous dimension block.
  const keeps = [
    "Téléviseur 50\"",                                  // lone bare inch, no letter/x, no " / " → kept
    "Armoire 71 x 61 cm",                                // metric, no inch mark → kept
    "Parasol 10' déporté",                               // feet apostrophe, not inch → kept
    "Chaise de patio - Gris",                            // no measurement at all → kept
    "Table console étroite 99 cm avec tiroirs",          // number mid-title, no inch → kept
    "Tuyau 1/2\"",                                       // fraction (no space before slash) → kept
  ];
  for (const input of keeps) {
    it(`keeps: ${input}`, () => expect(stripImperialDimensions(input)).toBe(input));
  }

  it("handles empty/whitespace input safely", () => {
    expect(stripImperialDimensions("")).toBe("");
    expect(stripImperialDimensions("   ")).toBe("   ");
  });
});

const PUBLISHED = "2024-01-01T00:00:00Z"; // a non-null Online Store publish timestamp

const fixtureProducts: ShopifyFeedProduct[] = [
  {
    id: 111, title: "Chaise de patio", handle: "chaise-de-patio", vendor: "Outsunny",
    status: "active", published_at: PUBLISHED, product_type: "Patio & Garden > Patio Furniture > Patio Chairs",
    body_html: "<p>Une <b>belle</b> chaise</p>",
    images: [{ src: "https://img/1.jpg" }, { src: "https://img/2.jpg" }],
    variants: [
      { sku: "PAT-001GY", price: "129.99", inventory_management: null, title: "Gris" },
      { sku: "PAT-001BK", price: "129.99", inventory_management: "shopify", inventory_quantity: 0, title: "Noir" },
    ],
  },
  { id: 222, title: "Brouillon", handle: "brouillon", status: "draft", published_at: PUBLISHED, images: [{ src: "x" }], variants: [{ sku: "D1", price: "10" }] }, // draft → skipped
  { id: 333, title: "Sans image", handle: "sans-image", status: "active", published_at: PUBLISHED, images: [], variants: [{ sku: "N1", price: "10" }] }, // no image → skipped
  { id: 444, title: "Prix zéro", handle: "px0", status: "active", published_at: PUBLISHED, images: [{ src: "y" }], variants: [{ sku: "Z1", price: "0" }] }, // price 0 → skipped
  { id: 888, title: "Actif non publié", handle: "actif-non-publie", status: "active", published_at: null, images: [{ src: "z" }], variants: [{ sku: "U1", price: "20" }] }, // active but unpublished → excluded (storefront 404)
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
  it("excludes active products not published to the Online Store (published_at null → storefront 404)", () => {
    // id 888 / SKU U1 is active with an image and a priced variant, but published_at is null.
    expect(items.find((i) => i.id === "U1")).toBeUndefined();
    // A published clone of the same product IS included — proves publish status is the only difference.
    const published = shopifyToFeedItems([
      { id: 889, title: "Actif publié", handle: "actif-publie", status: "active", published_at: PUBLISHED, images: [{ src: "z" }], variants: [{ sku: "U2", price: "20", inventory_management: null }] },
    ]);
    expect(published.map((i) => i.id)).toEqual(["U2"]);
  });
  it("excludes a scheduled (future-dated published_at) product — not live on the storefront yet", () => {
    const scheduled = shopifyToFeedItems([
      { id: 890, title: "Publication planifiée", handle: "planifie", status: "active", published_at: "2999-01-01T00:00:00Z", images: [{ src: "z" }], variants: [{ sku: "F1", price: "20", inventory_management: null }] },
    ]);
    expect(scheduled).toEqual([]);
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
  it("derives FR colour from the SKU suffix (g:color source)", () => {
    expect(items.find((i) => i.id === "PAT-001GY")!.color).toBe("Gris");
    expect(items.find((i) => i.id === "PAT-001BK")!.color).toBe("Noir");
    // A SKU with no recognised colour suffix → null.
    const noColor = shopifyToFeedItems([
      { id: 5, title: "X", handle: "x", status: "active", published_at: PUBLISHED, images: [{ src: "i" }], variants: [{ sku: "WIDGET99", price: "5", inventory_management: null }] },
    ]);
    expect(noColor[0].color).toBeNull();
  });
  it("treats untracked variants as in stock and tracked-zero as out of stock", () => {
    expect(items.find((i) => i.id === "PAT-001GY")!.availability).toBe("in stock");
    expect(items.find((i) => i.id === "PAT-001BK")!.availability).toBe("out of stock");
  });
  it("hides the supplier: brand falls back to the house brand, never 'Aosom'", () => {
    const noVendor = shopifyToFeedItems([{ ...fixtureProducts[0], id: 9, vendor: null, handle: "h", variants: [{ sku: "S", price: "5", inventory_management: null }] }]);
    expect(noVendor[0].brand).toBe("Ameublo Direct");
    // An explicit vendor of "Aosom" is also replaced.
    const aosomVendor = shopifyToFeedItems([{ ...fixtureProducts[0], id: 10, vendor: "Aosom", handle: "h2", variants: [{ sku: "S2", price: "5", inventory_management: null }] }]);
    expect(aosomVendor[0].brand).toBe("Ameublo Direct");
    // A real product vendor is kept.
    expect(items.find((i) => i.id === "PAT-001GY")!.brand).toBe("Outsunny");
  });
  it("scrubs 'Aosom' out of the title and description", () => {
    const scrubbed = shopifyToFeedItems([{
      id: 11, title: "Tour pour chat Aosom 168cm", handle: "tour", status: "active", published_at: PUBLISHED,
      vendor: null, body_html: "<p>Cette tour Aosom est solide. Marque Aosom.</p>",
      images: [{ src: "i" }], variants: [{ sku: "CAT-1", price: "20", inventory_management: null }],
    }]);
    expect(scrubbed[0].title).not.toMatch(/aosom/i);
    expect(scrubbed[0].description).not.toMatch(/aosom/i);
    expect(scrubbed[0].title).toContain("Ameublo Direct");
  });
  it("strips the imperial dimension suffix from the composed variant title", () => {
    const dims = shopifyToFeedItems([{
      id: 12, title: "Table de chevet", handle: "chevet", status: "active", published_at: PUBLISHED,
      vendor: "Outsunny", images: [{ src: "i" }],
      variants: [
        { sku: "CHV-1GY", price: "59.99", inventory_management: null, title: "Gris / 15.7\" W x 11.8\" D x 19.3\" H" },
        { sku: "CHV-1BK", price: "59.99", inventory_management: null, title: "Noir / 15.7\" W x 11.8\" D x 19.3\" H" },
      ],
    }]);
    expect(dims.find((i) => i.id === "CHV-1GY")!.title).toBe("Table de chevet - Gris");
    expect(dims.find((i) => i.id === "CHV-1BK")!.title).toBe("Table de chevet - Noir");
  });
  it("deduplicates g:id (SKU) across the whole feed", () => {
    const dup = shopifyToFeedItems([
      { id: 1, title: "A", handle: "a", status: "active", published_at: PUBLISHED, images: [{ src: "i" }], variants: [{ sku: "SAME", price: "10", inventory_management: null }] },
      { id: 2, title: "B", handle: "b", status: "active", published_at: PUBLISHED, images: [{ src: "i" }], variants: [{ sku: "SAME", price: "20", inventory_management: null }] },
    ]);
    expect(dup.map((i) => i.id)).toEqual(["SAME"]); // only the first wins
  });
});

describe("shopifyToFeedItems — preferEnglishTitle (Pinterest EN feed)", () => {
  const enProducts: ShopifyFeedProduct[] = [
    {
      id: 700, title: "Chaise de patio", titleEn: "Patio Chair", handle: "chaise-de-patio",
      vendor: "Outsunny", status: "active", published_at: PUBLISHED,
      product_type: "Patio & Garden > Patio Furniture > Patio Chairs",
      images: [{ src: "https://img/1.jpg" }],
      variants: [{ sku: "EN-001", price: "129.99", inventory_management: null }],
    },
    {
      id: 701, title: "Niche pour chien", titleEn: "  ", handle: "niche", status: "active", published_at: PUBLISHED, // blank EN → fallback
      images: [{ src: "https://img/2.jpg" }],
      variants: [{ sku: "EN-002", price: "59.99", inventory_management: null }],
    },
    {
      id: 702, title: "Tente de jardin", handle: "tente", status: "active", published_at: PUBLISHED, // no EN at all → fallback
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
    // Google accepts ONLY the underscore form; the spaced form is prose in their docs.
    expect(xml).toContain("<g:availability>in_stock</g:availability>");
    expect(xml).not.toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:condition>new</g:condition>");
    expect(xml).toContain("<g:brand>Outsunny</g:brand>");
    expect(xml).toContain("<g:google_product_category>6792</g:google_product_category>");
    expect(xml).toContain("<g:item_group_id>111</g:item_group_id>");
    expect(xml).toContain("<g:additional_image_link>https://img/2.jpg</g:additional_image_link>");
  });
  it("emits g:mpn (= SKU) and identifier_exists=true (Aosom catalog has no GTIN)", () => {
    expect(xml).toContain("<g:mpn>PAT-001GY</g:mpn>");
    expect(xml).toContain("<g:identifier_exists>true</g:identifier_exists>");
    expect(xml).not.toContain("<g:identifier_exists>false</g:identifier_exists>");
    // every product carries its own g:mpn (one per item)
    expect((xml.match(/<g:mpn>/g) || []).length).toBe(sample.length);
  });
  it("contains exactly one <item> per feed item", () => {
    expect((xml.match(/<item>/g) || []).length).toBe(sample.length);
  });
  it("emits g:color from the SKU suffix and a constant g:shipping block", () => {
    expect(xml).toContain("<g:color>Gris</g:color>");
    expect(xml).toContain("<g:color>Noir</g:color>");
    expect(xml).toContain("<g:shipping>");
    expect(xml).toContain("<g:country>CA</g:country>");
    expect(xml).toContain("<g:price>0 CAD</g:price>");
  });
});

describe("buildBingFeed", () => {
  const xml = buildBingFeed(sample, { title: "Bing", link: "https://x", description: "d" });
  it("is RSS 2.0 with the g: namespace", () => {
    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`xmlns:g="http://base.google.com/ns/1.0"`);
  });
  it("emits the Bing field set incl. shipping, one item per feed item", () => {
    expect(xml).toContain("<g:id>PAT-001GY</g:id>");
    expect(xml).toContain("<link>https://ameublodirect.ca/products/chaise-de-patio</link>");
    expect(xml).toContain("<g:image_link>https://img/1.jpg</g:image_link>");
    expect(xml).toContain("<g:price>129.99 CAD</g:price>");
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:brand>Outsunny</g:brand>");
    expect(xml).toContain("<g:product_type>Patio &amp; Garden &gt; Patio Furniture &gt; Patio Chairs</g:product_type>");
    expect(xml).toContain("<g:shipping>");
    expect((xml.match(/<item>/g) || []).length).toBe(sample.length);
  });
  it("omits Google-only fields not in the Bing set (condition, category)", () => {
    expect(xml).not.toContain("<g:condition>");
    expect(xml).not.toContain("<g:google_product_category>");
  });
});

describe("buildRedditFeed", () => {
  const xml = buildRedditFeed(sample, { title: "Reddit", link: "https://x", description: "d" });
  it("is RSS 2.0 with the g: namespace", () => {
    expect(xml).toContain(`xmlns:g="http://base.google.com/ns/1.0"`);
  });
  it("emits the Reddit field set incl. condition, one item per feed item", () => {
    expect(xml).toContain("<g:id>PAT-001GY</g:id>");
    expect(xml).toContain("<g:condition>new</g:condition>");
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).toContain("<g:price>129.99 CAD</g:price>");
    expect(xml).toContain("<link>https://ameublodirect.ca/products/chaise-de-patio</link>");
    expect(xml).toContain("<g:brand>Outsunny</g:brand>");
    expect((xml.match(/<item>/g) || []).length).toBe(sample.length);
  });
  it("omits fields not in the Reddit set (shipping, category)", () => {
    expect(xml).not.toContain("<g:shipping>");
    expect(xml).not.toContain("<g:google_product_category>");
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
    id: 555, title: "Parasol en solde", handle: "parasol", vendor: "Outsunny", status: "active", published_at: PUBLISHED,
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

// ── Google Shopping excellence: sale price + variant attributes ────────────

describe("saleSplit", () => {
  const at = (price: number, compareAtPrice: number | null) => saleSplit({ price, compareAtPrice });

  it("splits price/sale_price when the discount reaches 10%", () => {
    expect(at(79.99, 129.99)).toEqual({ price: 129.99, salePrice: 79.99 }); // 38% off
    expect(at(90, 100)).toEqual({ price: 100, salePrice: 90 });             // exactly 10%
  });
  it("keeps a single price below the 10% floor (storefront shows no strikethrough there)", () => {
    expect(at(95, 100)).toEqual({ price: 95, salePrice: null });   // 5% off
    expect(at(99.99, 104.99)).toEqual({ price: 99.99, salePrice: null }); // ~4.8% off
  });
  it("keeps a single price when there is no real discount", () => {
    expect(at(79.99, null)).toEqual({ price: 79.99, salePrice: null });
    expect(at(79.99, 50)).toEqual({ price: 79.99, salePrice: null });   // compare < price
    expect(at(79.99, 79.99)).toEqual({ price: 79.99, salePrice: null }); // equal
  });
  it("never divides by zero or emits a zero regular price", () => {
    expect(at(0, 100)).toEqual({ price: 0, salePrice: null });
    expect(at(50, 0)).toEqual({ price: 50, salePrice: null });
  });
});

describe("frenchifyColor", () => {
  const cases: Array<[string, string]> = [
    ["Black", "Noir"], ["White", "Blanc"], ["Grey", "Gris"], ["Gray", "Gris"],
    ["Rustic Brown", "Rustique Brun"],
    ["Charcoal Grey", "Anthracite Gris"],
    ["Multi Colour", "Multicolore"],           // "Colour" maps to empty and is dropped
    ["Natural Finish", "Naturel"],             // "Finish" maps to empty
    ["Green, Black", "Vert, Noir"],            // compound, comma-separated
    ["Brown, Green, White", "Brun, Vert, Blanc"],
    ["White Wood Grain", "Blanc Bois"],
  ];
  for (const [input, expected] of cases) {
    it(`maps "${input}" → "${expected}"`, () => expect(frenchifyColor(input)).toBe(expected));
  }
  it("passes unknown values through unchanged", () => {
    expect(frenchifyColor("Gris foncé")).toBe("Gris foncé");
    expect(frenchifyColor("Chêne clair")).toBe("Chêne clair");
  });
  it("returns null for empty input", () => {
    expect(frenchifyColor("")).toBeNull();
    expect(frenchifyColor(null)).toBeNull();
    expect(frenchifyColor(undefined)).toBeNull();
  });
});

// Variant-attribute fixture: real option shapes from the live catalog (Couleur + Taille).
const OPT_PUBLISHED = "2020-01-01T00:00:00-05:00";
const optionProducts: ShopifyFeedProduct[] = [
  {
    id: 777, title: "Abri de jardin", handle: "abri", vendor: "Ameublo Direct", status: "active",
    published_at: OPT_PUBLISHED, product_type: "Patio & Garden > Sheds",
    images: [{ src: "https://img/a.jpg" }],
    options: [{ name: "Couleur", position: 1 }, { name: "Taille", position: 2 }],
    variants: [
      { sku: "SHD-1GN", price: "199.99", option1: "Vert", option2: "7' x 4' x 6'", inventory_management: null },
      { sku: "SHD-2YL", price: "199.99", option1: "Earthy Yellow", option2: "7x4ft", inventory_management: null },
    ],
  },
  {
    // Single-variant product: Shopify's "Title / Default Title" placeholder carries nothing.
    id: 778, title: "Table basse", handle: "table", vendor: "Ameublo Direct", status: "active",
    published_at: OPT_PUBLISHED, product_type: "Home Furnishings > Tables",
    images: [{ src: "https://img/t.jpg" }],
    options: [{ name: "Title", position: 1 }],
    variants: [{ sku: "TBL-1", price: "89.99", option1: "Default Title", inventory_management: null }],
  },
];

describe("optionValue", () => {
  const p = optionProducts[0];
  it("resolves a value through the option's position", () => {
    expect(optionValue(p, p.variants![0], /^couleur$/i)).toBe("Vert");
    expect(optionValue(p, p.variants![0], /^taille$/i)).toBe("7' x 4' x 6'");
  });
  it("returns null for an option the product does not have", () => {
    expect(optionValue(p, p.variants![0], /^mati[eè]re$/i)).toBeNull();
  });
  it("treats Shopify's Default Title placeholder as absent", () => {
    const q = optionProducts[1];
    expect(optionValue(q, q.variants![0], /^title$/i)).toBeNull();
  });
});

describe("shopifyToFeedItems — colour and size from Shopify options", () => {
  const items = shopifyToFeedItems(optionProducts);
  it("prefers the Couleur option over the SKU suffix and translates it", () => {
    expect(items.find((i) => i.id === "SHD-1GN")!.color).toBe("Vert");
    expect(items.find((i) => i.id === "SHD-2YL")!.color).toBe("Terreux Jaune"); // was "Earthy Yellow"
  });
  it("carries the Taille option through as size", () => {
    expect(items.find((i) => i.id === "SHD-1GN")!.size).toBe("7' x 4' x 6'");
    expect(items.find((i) => i.id === "SHD-2YL")!.size).toBe("7x4ft");
  });
  it("leaves size null on a single-variant product", () => {
    expect(items.find((i) => i.id === "TBL-1")!.size).toBeNull();
  });
});

describe("buildGoogleFeed — sale price and variant attributes", () => {
  const items = shopifyToFeedItems([...saleProducts, ...optionProducts]);
  const xml = buildGoogleFeed(items, { title: "G", link: "https://x", description: "d" });
  const blockFor = (id: string) => xml.split("<item>").find((b) => b.includes(`<g:id>${id}</g:id>`))!;

  it("emits g:price = regular and g:sale_price = charged for a qualifying discount", () => {
    const b = blockFor("UMB-1");
    expect(b).toContain("<g:price>129.99 CAD</g:price>");
    expect(b).toContain("<g:sale_price>79.99 CAD</g:sale_price>");
  });
  it("omits g:sale_price when compare_at does not exceed the price", () => {
    const b = blockFor("UMB-2");
    expect(b).toContain("<g:price>79.99 CAD</g:price>");
    expect(b).not.toContain("<g:sale_price>");
  });
  it("emits g:color and g:size from the Shopify options", () => {
    const b = blockFor("SHD-2YL");
    expect(b).toContain("<g:color>Terreux Jaune</g:color>");
    expect(b).toContain("<g:size>7x4ft</g:size>");
  });
  it("omits g:size when the product has no size option", () => {
    expect(blockFor("TBL-1")).not.toContain("<g:size>");
  });
});

// ── g:material and g:sale_price_effective_date ────────────────────────────

describe("materialFromMetafields", () => {
  it("reads the first recognised key, in priority order", () => {
    expect(materialFromMetafields({ "custom.material": "Acier galvanisé" })).toBe("Acier galvanisé");
    expect(materialFromMetafields({ "custom.matiere": "Rotin synthétique" })).toBe("Rotin synthétique");
    expect(materialFromMetafields({ "mm-google-shopping.material": "Bois" })).toBe("Bois");
  });
  it("prefers custom.material when several are set", () => {
    expect(materialFromMetafields({ "custom.matiere": "Bois", "custom.material": "Acier" })).toBe("Acier");
  });
  it("trims surrounding whitespace", () => {
    expect(materialFromMetafields({ "custom.material": "  Aluminium  " })).toBe("Aluminium");
  });
  it("omits rather than invents — blank, missing and unrelated keys all yield null", () => {
    expect(materialFromMetafields({ "custom.material": "" })).toBeNull();
    expect(materialFromMetafields({ "custom.material": "   " })).toBeNull();
    expect(materialFromMetafields({ "custom.title_en": "Steel shed" })).toBeNull();
    expect(materialFromMetafields({})).toBeNull();
    expect(materialFromMetafields(null)).toBeNull();
    expect(materialFromMetafields(undefined)).toBeNull();
  });
  it("never derives a value from prose", () => {
    // The description names a material; the attribute must still be absent without a metafield.
    expect(materialFromMetafields({ "custom.body": "Structure en acier galvanisé" })).toBeNull();
  });
  it("exposes its key list so the feed and the runbook cannot drift", () => {
    expect(MATERIAL_METAFIELD_KEYS[0]).toBe("custom.material");
    expect(MATERIAL_METAFIELD_KEYS).toContain("mm-google-shopping.material");
  });
});

describe("salePriceEffectiveDate", () => {
  it("emits store-local whole-day boundaries with an explicit offset (summer, EDT)", () => {
    // 2026-08-06 16:00Z is 12:00 in Toronto, which is on EDT (-04:00).
    expect(salePriceEffectiveDate(new Date("2026-08-06T16:00:00Z")))
      .toBe("2026-08-06T00:00:00-04:00/2026-09-05T23:59:59-04:00");
  });

  it("uses -05:00 in winter (EST) — the offset is derived, never hardcoded", () => {
    expect(salePriceEffectiveDate(new Date("2026-01-15T17:00:00Z")))
      .toBe("2026-01-15T00:00:00-05:00/2026-02-14T23:59:59-05:00");
  });

  it("handles a window that starts on EST and ends on EDT (spring forward)", () => {
    // 2026-02-25 + 30d lands on 2026-03-27, after the second-Sunday-of-March switch.
    const out = salePriceEffectiveDate(new Date("2026-02-25T17:00:00Z"));
    expect(out).toBe("2026-02-25T00:00:00-05:00/2026-03-27T23:59:59-04:00");
  });

  it("carries no milliseconds and no bare Z", () => {
    const out = salePriceEffectiveDate(new Date("2026-08-06T16:00:00.456Z"));
    expect(out).not.toContain(".456");
    expect(out).not.toContain("Z");
  });

  it("spans 30 calendar days in store-local terms", () => {
    const [start, end] = salePriceEffectiveDate(new Date("2026-08-06T16:00:00Z")).split("/");
    expect(start.slice(0, 10)).toBe("2026-08-06");
    expect(end.slice(0, 10)).toBe("2026-09-05");
  });

  it("crosses the year boundary correctly", () => {
    expect(salePriceEffectiveDate(new Date("2026-12-20T17:00:00Z")))
      .toBe("2026-12-20T00:00:00-05:00/2027-01-19T23:59:59-05:00");
  });

  it("resolves the local day from the store zone, not from UTC", () => {
    // 2026-08-07 02:00Z is still 2026-08-06 22:00 in Toronto — the local day must win.
    expect(salePriceEffectiveDate(new Date("2026-08-07T02:00:00Z")).slice(0, 10)).toBe("2026-08-06");
  });
});

describe("availabilityValue — Google and Pinterest disagree, both strictly", () => {
  it("maps to underscores for Google", () => {
    expect(availabilityValue({ availability: "in stock" }, "underscore")).toBe("in_stock");
    expect(availabilityValue({ availability: "out of stock" }, "underscore")).toBe("out_of_stock");
  });
  it("passes the spaced form through for Pinterest", () => {
    expect(availabilityValue({ availability: "in stock" }, "spaced")).toBe("in stock");
    expect(availabilityValue({ availability: "out of stock" }, "spaced")).toBe("out of stock");
  });
});

describe("availability per channel — the Pinterest regression guard", () => {
  const opts = { title: "T", link: "https://x", description: "d" };
  it("Google emits in_stock", () => {
    const xml = buildGoogleFeed(sample, opts);
    expect(xml).toContain("<g:availability>in_stock</g:availability>");
    expect(xml).not.toContain("<g:availability>in stock</g:availability>");
  });
  it("Pinterest keeps the spaced form even though it reuses the Google builder", () => {
    const xml = buildPinterestFeed(sample, opts);
    expect(xml).toContain("<g:availability>in stock</g:availability>");
    expect(xml).not.toContain("<g:availability>in_stock</g:availability>");
  });
  it("Bing, Reddit and Meta-XML are untouched by the Google change", () => {
    for (const xml of [buildBingFeed(sample, opts), buildRedditFeed(sample, opts), buildMetaXmlFeed(sample, opts)]) {
      expect(xml).toContain("<g:availability>in stock</g:availability>");
      expect(xml).not.toContain("<g:availability>in_stock</g:availability>");
    }
  });
  it("the Meta JSON feed keeps the spaced form", () => {
    expect(buildMetaFeed(sample)[0].availability).toBe("in stock");
  });
});

describe("buildGoogleFeed — material and sale window", () => {
  const NOW = new Date("2026-08-06T16:00:00.000Z"); // 12:00 Toronto (EDT)
  const matProducts: ShopifyFeedProduct[] = [
    {
      id: 901, title: "Abri en acier", handle: "abri-acier", vendor: "Ameublo Direct", status: "active",
      published_at: "2020-01-01T00:00:00-05:00", product_type: "Patio & Garden > Sheds",
      body_html: "<p>Structure en acier galvanisé résistant aux intempéries. Assemblage requis.</p>",
      images: [{ src: "https://img/s.jpg" }],
      metafields: { "custom.material": "Acier galvanisé" },
      variants: [{ sku: "MAT-1", price: "89.99", compare_at_price: "129.99", inventory_management: null }],
    },
    {
      // Description names a material but no metafield is set — the attribute must be absent.
      id: 902, title: "Coussin", handle: "coussin", vendor: "Ameublo Direct", status: "active",
      published_at: "2020-01-01T00:00:00-05:00", product_type: "Home Furnishings > Cushions",
      body_html: "<p>Housse en polyester déhoussable. Assemblage requis.</p>",
      images: [{ src: "https://img/c.jpg" }],
      variants: [{ sku: "MAT-2", price: "19.99", inventory_management: null }],
    },
  ];
  const items = shopifyToFeedItems(matProducts);
  const xml = buildGoogleFeed(items, { title: "G", link: "https://x", description: "d" }, NOW);
  const blockFor = (id: string) => xml.split("<item>").find((b) => b.includes(`<g:id>${id}</g:id>`))!;

  it("emits g:material from the metafield", () => {
    expect(blockFor("MAT-1")).toContain("<g:material>Acier galvanisé</g:material>");
  });
  it("omits g:material when only the description names one", () => {
    expect(blockFor("MAT-2")).not.toContain("<g:material>");
  });
  it("pairs g:sale_price with a 30-day g:sale_price_effective_date", () => {
    const b = blockFor("MAT-1");
    expect(b).toContain("<g:sale_price>89.99 CAD</g:sale_price>");
    expect(b).toContain("<g:sale_price_effective_date>2026-08-06T00:00:00-04:00/2026-09-05T23:59:59-04:00</g:sale_price_effective_date>");
  });
  it("emits no effective date when there is no sale", () => {
    expect(blockFor("MAT-2")).not.toContain("<g:sale_price_effective_date>");
  });
  it("passes a real Date to every item (map index must not leak into `now`)", () => {
    expect(() => buildGoogleFeed(items, { title: "G", link: "https://x", description: "d" })).not.toThrow();
  });
});
