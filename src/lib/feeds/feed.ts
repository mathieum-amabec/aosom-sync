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
  color?: string | null;         // FR colour, from the Shopify option or the SKU suffix (g:color)
  size?: string | null;          // Shopify "Taille" option value (g:size), null when none
  material?: string | null;      // primary material read from the description (g:material)
  productType: string;           // Aosom taxonomy path (g:product_type)
  googleCategoryId: number;      // g:google_product_category
}

// Google renders a strikethrough "was" price only when the feed splits price/sale_price:
// `price` must carry the REGULAR price and `sale_price` the amount actually charged.
//
// The 10% floor mirrors the storefront, which only shows its own strikethrough at >= 10%
// off. Keeping the two in sync matters: Google crawls the landing page and compares it to
// the feed, so claiming a sale the page does not display invites a price-mismatch
// disapproval. Below the floor we keep the single-price shape (price = what you pay),
// which is always consistent with the page.
const SALE_MIN_DISCOUNT = 0.1;

/** Split an item into the (regular, sale) pair Google expects.
 * `salePrice` is null when the item is not on a qualifying sale, in which case `price`
 * stays the current selling price exactly as before. */
export function saleSplit(it: Pick<FeedItem, "price" | "compareAtPrice">): {
  price: number;
  salePrice: number | null;
} {
  const regular = it.compareAtPrice ?? 0;
  if (!(regular > it.price) || it.price <= 0) return { price: it.price, salePrice: null };
  const discount = (regular - it.price) / regular;
  if (discount < SALE_MIN_DISCOUNT) return { price: it.price, salePrice: null };
  return { price: regular, salePrice: it.price };
}

// Shopify's compare_at_price carries NO schedule — there is no promo start or end stored
// anywhere. So this window is not a Shopify promotion being reported; it is a forward
// validity declaration anchored to feed-generation time: "this sale price holds from now
// for SALE_WINDOW_DAYS".
//
// That is honest because the feed is regenerated on every fetch and Google re-fetches
// daily: the moment the merchant ends a sale, the next feed drops both sale_price and this
// date, and Google honours the newest feed — so the declared window is always superseded
// by fresher data long before it expires.
const SALE_WINDOW_DAYS = 30;

const isoSecond = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Google's `sale_price_effective_date`: an ISO 8601 interval "<start>/<end>".
 * `now` is injectable so the output is deterministic under test. */
export function salePriceEffectiveDate(now: Date = new Date()): string {
  const end = new Date(now.getTime() + SALE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return `${isoSecond(now)}/${isoSecond(end)}`;
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
function googleItemXml(it: FeedItem, now?: Date): string {
  const { price, salePrice } = saleSplit(it);
  const g: string[] = [
    `<g:id>${escapeXml(it.id)}</g:id>`,
    `<title>${escapeXml(it.title)}</title>`,
    `<description>${escapeXml(it.description)}</description>`,
    `<link>${escapeXml(it.link)}</link>`,
    `<g:image_link>${escapeXml(it.imageLink)}</g:image_link>`,
    ...it.additionalImageLinks.slice(0, 10).map((u) => `<g:additional_image_link>${escapeXml(u)}</g:additional_image_link>`),
    `<g:availability>${it.availability}</g:availability>`,
    `<g:price>${escapeXml(formatPrice(price))}</g:price>`,
    salePrice != null ? `<g:sale_price>${escapeXml(formatPrice(salePrice))}</g:sale_price>` : "",
    salePrice != null ? `<g:sale_price_effective_date>${escapeXml(salePriceEffectiveDate(now))}</g:sale_price_effective_date>` : "",
    `<g:condition>${it.condition}</g:condition>`,
    `<g:brand>${escapeXml(it.brand)}</g:brand>`,
    it.color ? `<g:color>${escapeXml(it.color)}</g:color>` : "",
    it.size ? `<g:size>${escapeXml(it.size)}</g:size>` : "",
    it.material ? `<g:material>${escapeXml(it.material)}</g:material>` : "",
    `<g:google_product_category>${it.googleCategoryId}</g:google_product_category>`,
    it.productType ? `<g:product_type>${escapeXml(it.productType)}</g:product_type>` : "",
    it.itemGroupId ? `<g:item_group_id>${escapeXml(it.itemGroupId)}</g:item_group_id>` : "",
    SHIPPING_BLOCK,
    // No GTIN in the Aosom catalog, but the Aosom item SKU (== g:id) is the supplier part
    // number, so we emit it as g:mpn. brand + MPN is a valid Google identifier pair, which
    // lets us declare identifier_exists=true (better Shopping/PMax matching than false).
    `<g:mpn>${escapeXml(it.id)}</g:mpn>`,
    `<g:identifier_exists>true</g:identifier_exists>`,
  ].filter(Boolean);
  return `    <item>\n      ${g.join("\n      ")}\n    </item>`;
}

export function buildGoogleFeed(items: FeedItem[], opts: { title: string; link: string; description: string }, now?: Date): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(opts.title)}</title>
    <link>${escapeXml(opts.link)}</link>
    <description>${escapeXml(opts.description)}</description>
${items.map((it) => googleItemXml(it, now)).join("\n")}
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
