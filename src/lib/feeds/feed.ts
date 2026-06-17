// Pure feed model + serializers (no I/O — fully unit-testable).
import { mapToGoogleCategory } from "./google-category";

export interface FeedItem {
  id: string;                    // variant SKU (g:id)
  itemGroupId?: string | null;   // Shopify product id — groups variants
  title: string;
  description: string;           // plain text
  link: string;                  // https://ameublodirect.ca/products/{handle}
  imageLink: string;
  additionalImageLinks: string[];
  price: number;                 // numeric, CAD (current selling price)
  compareAtPrice?: number | null; // Shopify compare_at_price — the regular "was" price when on sale
  availability: "in stock" | "out of stock";
  condition: "new";
  brand: string;
  color?: string | null;         // FR colour from the SKU suffix (g:color), null when none
  productType: string;           // Aosom taxonomy path (g:product_type)
  googleCategoryId: number;      // g:google_product_category
}

const CURRENCY = "CAD";

// Flat free shipping to Canada (Ameublo Direct absorbs shipping). Emitted as a constant
// item-level <g:shipping> block on the feeds that carry shipping (Google, Bing). Indented
// to sit at the 6-space item-field level once joined.
const SHIPPING_BLOCK =
  "<g:shipping>\n        <g:country>CA</g:country>\n        <g:price>0 CAD</g:price>\n      </g:shipping>";

// XML 1.0 forbids these control chars entirely — a single one anywhere makes the WHOLE
// RSS document invalid and Google/Pinterest reject the entire feed. Built from escapes so
// there are no literal control bytes in source.
const XML_INVALID = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

// ── text helpers ──────────────────────────────────────────────────────────
export function escapeXml(s: string): string {
  return String(s ?? "")
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function stripHtml(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, " ")     // drop tags
    .replace(/&nbsp;/gi, " ")
    .replace(XML_INVALID, "")     // drop XML-forbidden control chars
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(s: string, max: number): string {
  // Slice by code points so we never cut an astral emoji into a lone surrogate
  // (a lone surrogate is invalid XML).
  const cp = Array.from(String(s ?? ""));
  return cp.length <= max ? cp.join("") : cp.slice(0, max - 1).join("").trimEnd() + "…";
}

export function formatPrice(price: number): string {
  return `${(Number(price) || 0).toFixed(2)} ${CURRENCY}`;
}

// ── Google Merchant feed (RSS 2.0 + g: namespace) ─────────────────────────
function googleItemXml(it: FeedItem): string {
  const g: string[] = [
    `<g:id>${escapeXml(it.id)}</g:id>`,
    `<title>${escapeXml(it.title)}</title>`,
    `<description>${escapeXml(it.description)}</description>`,
    `<link>${escapeXml(it.link)}</link>`,
    `<g:image_link>${escapeXml(it.imageLink)}</g:image_link>`,
    ...it.additionalImageLinks.slice(0, 10).map((u) => `<g:additional_image_link>${escapeXml(u)}</g:additional_image_link>`),
    `<g:availability>${it.availability}</g:availability>`,
    `<g:price>${escapeXml(formatPrice(it.price))}</g:price>`,
    `<g:condition>${it.condition}</g:condition>`,
    `<g:brand>${escapeXml(it.brand)}</g:brand>`,
    it.color ? `<g:color>${escapeXml(it.color)}</g:color>` : "",
    `<g:google_product_category>${it.googleCategoryId}</g:google_product_category>`,
    it.productType ? `<g:product_type>${escapeXml(it.productType)}</g:product_type>` : "",
    it.itemGroupId ? `<g:item_group_id>${escapeXml(it.itemGroupId)}</g:item_group_id>` : "",
    SHIPPING_BLOCK,
    `<g:identifier_exists>false</g:identifier_exists>`, // no GTIN/MPN in the catalog
  ].filter(Boolean);
  return `    <item>\n      ${g.join("\n      ")}\n    </item>`;
}

export function buildGoogleFeed(items: FeedItem[], opts: { title: string; link: string; description: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(opts.title)}</title>
    <link>${escapeXml(opts.link)}</link>
    <description>${escapeXml(opts.description)}</description>
${items.map(googleItemXml).join("\n")}
  </channel>
</rss>`;
}

// ── Bing / Microsoft Shopping feed (RSS 2.0 + g:) ─────────────────────────
// Microsoft Advertising ingests the Google Shopping feed format, so we emit the same
// RSS+g: shape with the Bing field subset: id, title, description, link, image_link,
// price, availability, brand, product_type, shipping. No condition/category needed.
function bingItemXml(it: FeedItem): string {
  const g: string[] = [
    `<g:id>${escapeXml(it.id)}</g:id>`,
    `<title>${escapeXml(it.title)}</title>`,
    `<description>${escapeXml(it.description)}</description>`,
    `<link>${escapeXml(it.link)}</link>`,
    `<g:image_link>${escapeXml(it.imageLink)}</g:image_link>`,
    `<g:price>${escapeXml(formatPrice(it.price))}</g:price>`,
    `<g:availability>${it.availability}</g:availability>`,
    `<g:brand>${escapeXml(it.brand)}</g:brand>`,
    it.productType ? `<g:product_type>${escapeXml(it.productType)}</g:product_type>` : "",
    SHIPPING_BLOCK,
  ].filter(Boolean);
  return `    <item>\n      ${g.join("\n      ")}\n    </item>`;
}

export function buildBingFeed(items: FeedItem[], opts: { title: string; link: string; description: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(opts.title)}</title>
    <link>${escapeXml(opts.link)}</link>
    <description>${escapeXml(opts.description)}</description>
${items.map(bingItemXml).join("\n")}
  </channel>
</rss>`;
}

// ── Reddit DPA catalog feed (RSS 2.0 + g:) ────────────────────────────────
// Reddit's Dynamic Product Ads catalog ingests the standard RSS+g: product feed.
// Field subset: id, title, description, availability, condition, price, link,
// image_link, brand, product_type. No shipping/category.
function redditItemXml(it: FeedItem): string {
  const g: string[] = [
    `<g:id>${escapeXml(it.id)}</g:id>`,
    `<title>${escapeXml(it.title)}</title>`,
    `<description>${escapeXml(it.description)}</description>`,
    `<g:availability>${it.availability}</g:availability>`,
    `<g:condition>${it.condition}</g:condition>`,
    `<g:price>${escapeXml(formatPrice(it.price))}</g:price>`,
    `<link>${escapeXml(it.link)}</link>`,
    `<g:image_link>${escapeXml(it.imageLink)}</g:image_link>`,
    `<g:brand>${escapeXml(it.brand)}</g:brand>`,
    it.productType ? `<g:product_type>${escapeXml(it.productType)}</g:product_type>` : "",
  ].filter(Boolean);
  return `    <item>\n      ${g.join("\n      ")}\n    </item>`;
}

export function buildRedditFeed(items: FeedItem[], opts: { title: string; link: string; description: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(opts.title)}</title>
    <link>${escapeXml(opts.link)}</link>
    <description>${escapeXml(opts.description)}</description>
${items.map(redditItemXml).join("\n")}
  </channel>
</rss>`;
}

// ── Pinterest feed (RSS 2.0, same g: namespace; favors extra square images) ─
export function buildPinterestFeed(items: FeedItem[], opts: { title: string; link: string; description: string }): string {
  // Pinterest consumes the same RSS+g: shape as Google. We keep additional_image_link
  // (Pinterest prefers larger/square images — those are surfaced via these extras).
  return buildGoogleFeed(items, opts);
}

// ── Meta Catalog feed (RSS 2.0 + g:) — Meta rejects JSON; it ingests RSS/ATOM XML ──
// Same shape as Google, plus: g:custom_label_0 = product_type, and g:sale_price when the
// item is discounted (g:price then carries the regular/compare-at price).
function metaXmlItemXml(it: FeedItem): string {
  const onSale = it.compareAtPrice != null && it.compareAtPrice > it.price;
  const regular = onSale ? (it.compareAtPrice as number) : it.price;
  const g: string[] = [
    `<g:id>${escapeXml(it.id)}</g:id>`,
    `<title>${escapeXml(it.title)}</title>`,
    `<description>${escapeXml(it.description)}</description>`,
    `<link>${escapeXml(it.link)}</link>`,
    `<g:image_link>${escapeXml(it.imageLink)}</g:image_link>`,
    ...it.additionalImageLinks.slice(0, 10).map((u) => `<g:additional_image_link>${escapeXml(u)}</g:additional_image_link>`),
    `<g:availability>${it.availability}</g:availability>`,
    `<g:price>${escapeXml(formatPrice(regular))}</g:price>`,
    onSale ? `<g:sale_price>${escapeXml(formatPrice(it.price))}</g:sale_price>` : "",
    `<g:condition>${it.condition}</g:condition>`,
    `<g:brand>${escapeXml(it.brand)}</g:brand>`,
    `<g:google_product_category>${it.googleCategoryId}</g:google_product_category>`,
    it.productType ? `<g:product_type>${escapeXml(it.productType)}</g:product_type>` : "",
    it.productType ? `<g:custom_label_0>${escapeXml(it.productType)}</g:custom_label_0>` : "",
    it.itemGroupId ? `<g:item_group_id>${escapeXml(it.itemGroupId)}</g:item_group_id>` : "",
    `<g:identifier_exists>false</g:identifier_exists>`,
  ].filter(Boolean);
  return `    <item>\n      ${g.join("\n      ")}\n    </item>`;
}

export function buildMetaXmlFeed(items: FeedItem[], opts: { title: string; link: string; description: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(opts.title)}</title>
    <link>${escapeXml(opts.link)}</link>
    <description>${escapeXml(opts.description)}</description>
${items.map(metaXmlItemXml).join("\n")}
  </channel>
</rss>`;
}

// ── Meta (Facebook/Instagram) Product Catalog feed (JSON) ─────────────────
export interface MetaFeedItem {
  id: string;
  title: string;
  description: string;
  availability: "in stock" | "out of stock";
  condition: "new";
  price: string;          // "41.99 CAD"
  link: string;
  image_link: string;
  brand: string;
  google_product_category: number;
  additional_image_link?: string;
  item_group_id?: string;
}

export function buildMetaFeed(items: FeedItem[]): MetaFeedItem[] {
  return items.map((it) => ({
    id: it.id,
    title: it.title,
    description: it.description,
    availability: it.availability,
    condition: it.condition,
    price: formatPrice(it.price),
    link: it.link,
    image_link: it.imageLink,
    brand: it.brand,
    google_product_category: it.googleCategoryId,
    ...(it.additionalImageLinks.length > 0 ? { additional_image_link: it.additionalImageLinks.slice(0, 10).join(",") } : {}),
    ...(it.itemGroupId ? { item_group_id: it.itemGroupId } : {}),
  }));
}

// ── shared category helper re-export so routes/source import from one place ─
export { mapToGoogleCategory };
