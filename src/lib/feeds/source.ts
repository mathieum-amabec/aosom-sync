// Feed data source: pull ACTIVE published products from Shopify (FR title + vendor +
// handle + images live there, and only Shopify knows which products are 'active').
// The pure mapper `shopifyToFeedItems` is unit-tested; `getFeedItems` does the fetch.
import { SHOPIFY } from "@/lib/config";
import { STOREFRONT_BASE_URL, EN_STOREFRONT_BASE_URL } from "@/lib/insights";
import { type FeedDetail, type FeedItem, mapToGoogleCategory, stripHtml, truncate } from "./feed";
import { FIT_DIMS_KEY, FIT_DIMS_NAMESPACE, type FitDims } from "../fit-dims";
import { parseSku } from "../variant-merger";
import { isSpecImageUrl } from "../selectors/shopify-product";
import { imageUrlStem } from "../image-compliance-audit";
import { getCachedImageVerdicts } from "../database";

export interface ShopifyFeedVariant {
  /** Shopify variant id — drives the `?variant=` deep link on multi-variant products. */
  id?: number | string | null;
  /** The variant's own image (products.json `images[].id`), null when none is assigned. */
  image_id?: number | string | null;
  sku: string | null;
  price: string | null;
  compare_at_price?: string | null;
  inventory_quantity?: number | null;
  inventory_management?: string | null;
  title?: string | null;
  /** Shopify variant option values, positionally aligned with product.options. */
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}
export interface ShopifyFeedProduct {
  id: number | string;
  title: string;
  handle: string;
  vendor?: string | null;
  status: string;
  product_type?: string | null;
  body_html?: string | null;
  /** Option definitions (name + 1-based position). The catalog only ever uses
   * "Couleur" and "Taille"; `position` tells us which variant.optionN to read. */
  options?: Array<{ name?: string | null; position?: number | null }>;
  /** Shopify Online Store publish timestamp (ISO) — null when the product is active but
   * NOT published to the storefront. Such a product's /products/{handle} page 404s, so it
   * must be excluded from the feed (Google Merchant: "Product page unavailable"). */
  published_at?: string | null;
  images?: Array<{ id?: number | string | null; src: string }>;
  variants?: ShopifyFeedVariant[];
  /** English product title from the custom.title_en metafield. Only populated for the
   * EN feed; absent/empty falls back to the FR `title`. */
  titleEn?: string | null;
  /** English description (custom.body_html_en metafield, HTML). EN feed only; absent/empty falls back to the FR body_html. */
  bodyEn?: string | null;
  /** Selected product metafields keyed "namespace.key". Only the keys the feed actually
   * reads are populated (see MATERIAL_METAFIELD_KEYS); absent when none are defined. */
  metafields?: Record<string, string | null | undefined> | null;
}

const DESCRIPTION_MAX = 5000;

// Hide the dropship supplier ("Aosom") from public feeds — "Ameublo Direct" is the
// storefront brand customers should see. Drives the brand fallback and scrubs the supplier
// name out of titles/descriptions so the feeds carry zero supplier references.
// NOTE: a product's URL handle can still embed "aosom" (e.g. /products/...-aosom-...);
// those are live Shopify handles and must be changed Shopify-side (+ redirects) — they
// cannot be rewritten in the feed without producing 404 links.
const HOUSE_BRAND = "Ameublo Direct";
const SUPPLIER_WORD = /\baosom\b/i; // single match (no /g — safe with .test())
const SUPPLIER_GLOBAL = /\baosom\b/gi; // replace-all

// English feeds carry the store's EN identity, "Furnish Direct". That is NOT a separate shop:
// it is the same 27u5y2-kp store, served in English at the root of furnishdirect.ca (attached to
// the Canada market next to ameublodirect.ca on 2026-10-25). EN offers link to
// EN_STOREFRONT_BASE_URL/products/{handle}. The old ameublodirect.ca/en/... URLs now 301 there,
// and a redirecting landing page is a Merchant Center disapproval — never link them.
const HOUSE_BRAND_EN = "Furnish Direct";

/** Replace any "Aosom" occurrence with the house brand and tidy whitespace.
 * `houseBrand` selects the locale's identity so an EN description never reads
 * "Ameublo Direct" on a page that brands itself Furnish Direct. */
export function scrubSupplier(s: string, houseBrand: string = HOUSE_BRAND): string {
  return s.replace(SUPPLIER_GLOBAL, houseBrand).replace(/\s{2,}/g, " ").trim();
}

// Google's title and description guidelines prohibit promotional text — "free shipping" is
// the named example. Product copy generated at import time sometimes ends up with a
// "Livraison gratuite partout au Canada" tail (18 live descriptions as of 2026-08-06), which
// makes the offer non-compliant even though the price and link are fine. Strip it in the feed
// layer rather than rewriting Shopify: the storefront may legitimately advertise free
// shipping, only the feed must not.
//
// Matched conservatively — the trailing qualifier is an explicit word list, never a greedy
// run — so a real sentence is never swallowed. Covers the observed variants:
//   "Livraison gratuite partout au Canada" / "… au Canada." / "… au Canada!" / "… au Canada !"
//   "Livraison gratuite - Partout au Canada" / "Livraison gratuite disponible."
// plus the English equivalent for the EN feed.
const PROMO_SHIPPING =
  /\s*(?:livraison\s+gratuite|free\s+shipping)(?:\s*[-–—]\s*)?(?:\s*(?:partout|everywhere))?(?:\s*(?:au|en|across|in|to)\s+canada)?(?:\s*(?:disponible|available))?\s*[!.]*\s*/gi;

/** Remove promotional shipping claims (Google prohibits them in title/description).
 * Only whitespace is normalised afterwards — no punctuation tightening, because French
 * typography puts a space before `:`, `!` and `?` and collapsing it would corrupt the copy. */
export function stripPromoText(s: string): string {
  return s.replace(PROMO_SHIPPING, " ").replace(/\s{2,}/g, " ").trim();
}

// The catalog's "Couleur" option is mostly French already, but ~19 of the 61 distinct values
// arrived from Aosom in English ("Rustic Brown", "Charcoal Grey", "Multi Colour"). The feed
// targets a Quebec French audience, so map what we can and pass through anything unknown
// unchanged — a slightly-off colour is far better than a dropped attribute.
//
// Compound values ("Green, Black", "Brown, Green, White") are translated part by part.
const COLOR_EN_FR: Record<string, string> = {
  black: "Noir", white: "Blanc", grey: "Gris", gray: "Gris", green: "Vert",
  blue: "Bleu", red: "Rouge", yellow: "Jaune", brown: "Brun", beige: "Beige",
  pink: "Rose", purple: "Violet", orange: "Orange", cream: "Crème", ivory: "Ivoire",
  navy: "Bleu marine", silver: "Argent", gold: "Or", natural: "Naturel", teak: "Teck",
  charcoal: "Anthracite", wood: "Bois", multi: "Multicolore", colour: "", color: "",
  rustic: "Rustique", earthy: "Terreux", finish: "", grain: "",
};

/** Translate a Shopify colour option value to French, part by part.
 * "Rustic Brown" → "Brun rustique" is out of scope — we keep word order and only swap
 * known tokens, so "Rustic Brown" → "Rustique Brun". Unknown tokens pass through. */
export function frenchifyColor(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s*,\s*/).map((part) =>
    part
      .split(/\s+/)
      .map((word) => {
        const hit = COLOR_EN_FR[word.toLowerCase().replace(/[^a-z]/g, "")];
        return hit === undefined ? word : hit;
      })
      .filter(Boolean)
      .join(" ")
      .trim(),
  );
  const out = parts.filter(Boolean).join(", ").replace(/\s{2,}/g, " ").trim();
  return out || null;
}

/** Read a variant's value for the product option whose name matches `match`.
 * Shopify stores option values positionally (variant.option1..3) against
 * product.options[].position, so we resolve the position first. */
export function optionValue(
  product: ShopifyFeedProduct,
  variant: ShopifyFeedVariant,
  match: RegExp,
): string | null {
  const opt = (product.options ?? []).find((o) => match.test((o?.name ?? "").trim()));
  const pos = opt?.position;
  if (pos !== 1 && pos !== 2 && pos !== 3) return null;
  const value = pos === 1 ? variant.option1 : pos === 2 ? variant.option2 : variant.option3;
  const trimmed = (value ?? "").trim();
  // Shopify's placeholder for a single-variant product carries no information.
  if (!trimmed || trimmed === "Default Title") return null;
  return trimmed;
}

const COLOUR_OPTION = /^(couleur|color|colour)$/i;
const SIZE_OPTION = /^(taille|size|dimension|dimensions)$/i;

// <g:material> comes from a Shopify metafield and nowhere else. Deriving it from the
// description prose was tried and removed: the value read fine most of the time, but it was
// inferred rather than declared, and a feed attribute that guesses is worse than one that is
// absent — Google treats `material` as a factual product claim.
//
// Recognised metafield keys, in priority order. None of these exist on the store today
// (verified against metafieldDefinitions for PRODUCT and PRODUCTVARIANT on 2026-08-06), so
// the attribute is simply omitted. Populate any one of them and it starts flowing with no
// code change.
export const MATERIAL_METAFIELD_KEYS = [
  "custom.material",
  "custom.matiere",
  "custom.matière",
  "mm-google-shopping.material",
] as const;

/** Pick the material from a product's metafields, or null when none is set.
 * `metafields` is keyed "namespace.key" exactly as MATERIAL_METAFIELD_KEYS spells them. */
export function materialFromMetafields(
  metafields: Record<string, string | null | undefined> | null | undefined,
): string | null {
  if (!metafields) return null;
  for (const key of MATERIAL_METAFIELD_KEYS) {
    const value = metafields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

// Aosom variant "size" options carry English/imperial measurements that leak into the FR
// title as a trailing `… - Couleur / <dims>` suffix, e.g. `42.1" x 24.6" x 17.3"`,
// `15.7" W x 11.8" D x 19.3" H` (spaces optional before the L/W/D/H letter), an adjustable
// range `43.75"-46.75" H`, or a width-only `47"`. For the Quebec FR / metric market those
// suffixes are noise, so we drop the trailing block.
//
// Matched conservatively so a real product name is never eaten. Only the TRAILING run is
// removed, in one of two shapes:
//   ALT1 — a `/`-delimited run: " / " (the variant-option delimiter) followed by any inch
//          run. The leading-space requirement keeps fractions like `1/2"` from matching.
//   ALT2 — no slash, but unambiguous: two+ axes joined by `x`, OR a single axis that bears a
//          dimension letter (L/W/D/H). A lone bare `50"` in a real name has neither → kept.
// Each axis allows an adjustable `N"-M"` range and an optional trailing dimension letter.
const AXIS = `\\d+(?:\\.\\d+)?\\s*"\\s*(?:[-\\u2013]\\s*\\d+(?:\\.\\d+)?\\s*"\\s*)?[LWDH]?`;
const AXES = `${AXIS}(?:\\s*[x\\u00d7]\\s*${AXIS})*`; // one or more axes joined by x
const AXES_MULTI = `${AXIS}(?:\\s*[x\\u00d7]\\s*${AXIS})+`; // two or more axes
const AXIS_LETTERED = `\\d+(?:\\.\\d+)?\\s*"\\s*(?:[-\\u2013]\\s*\\d+(?:\\.\\d+)?\\s*"\\s*)?[LWDH]`;
const IMPERIAL_DIM_SUFFIX = new RegExp(
  `(?:\\s+/\\s*${AXES}|\\s*[,\\u2013\\u2014-]?\\s*(?:${AXES_MULTI}|${AXIS_LETTERED}))\\s*$`,
  "i",
);

/** Strip a trailing imperial dimension suffix from a feed title (see IMPERIAL_DIM_SUFFIX).
 * Returns the title unchanged when no such suffix is present; otherwise removes it and
 * tidies any leftover trailing separator/comma/whitespace. */
export function stripImperialDimensions(title: string): string {
  const src = String(title ?? "");
  const cleaned = src.replace(IMPERIAL_DIM_SUFFIX, "");
  if (cleaned === src) return src;
  return cleaned.replace(/[\s,/–—-]+$/u, "").trim();
}

// Either house brand, whichever locale it came from. Used to recognise our OWN name in the
// Shopify `vendor` field (see resolveBrand).
// <g:product_highlight>: Google wants 2–100 short, scannable fragments and recommends 4–6;
// AI Mode and Gemini quote them when answering "does it…?" questions. Our descriptions
// already carry exactly that as the "Caractéristiques" bullet list (250/250 sampled
// 2026-10-30 had one, median 7 bullets), so we reuse the bullets verbatim: no generated text,
// nothing the product page does not already say.
const HIGHLIGHT_MAX = 6;
const HIGHLIGHT_MIN_CHARS = 12; // drops empty and one-word stubs
// "Assemblage requis" closes most bullet lists: true, but it answers no shopper question.
const ASSEMBLY_STUB = /^(?:assemblage|montage)\s+(?:requis|nécessaire)$|^assembly\s+required$/i;
const HIGHLIGHT_MAX_CHARS = 150; // Google's per-highlight limit

/** Up to 6 highlights from the description's <li> bullets, or [] when fewer than 2 qualify
 * (Google rejects a single highlight). Supplier names and shipping promos are scrubbed the
 * same way as the description. */
export function highlightsFromBody(html: string | null | undefined, houseBrand: string = HOUSE_BRAND): string[] {
  const bullets = Array.from(String(html ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi), (m) =>
    stripPromoText(scrubSupplier(stripHtml(m[1]), houseBrand)).replace(/[\s.;:,]+$/u, ""),
  ).filter((b) => b.length >= HIGHLIGHT_MIN_CHARS && b.length <= HIGHLIGHT_MAX_CHARS && !ASSEMBLY_STUB.test(b));
  const unique = Array.from(new Set(bullets)).slice(0, HIGHLIGHT_MAX);
  return unique.length >= 2 ? unique : [];
}

export const DIMS_METAFIELD_KEY = `${FIT_DIMS_NAMESPACE}.${FIT_DIMS_KEY}`;

/** <g:product_detail> rows for a variant's assembled size, read from the fit checker's
 * custom.lc_dims metafield (cm, [width, depth, height], already checked against the product
 * page by fit-dims-sync). [] when the metafield is missing, malformed or has no entry for
 * this SKU — a wrong dimension is worse than none. */
export function dimensionDetails(raw: string | null | undefined, sku: string, english: boolean): FeedDetail[] {
  if (!raw) return [];
  let dims: FitDims;
  try {
    dims = JSON.parse(raw) as FitDims;
  } catch {
    return [];
  }
  const p = dims?.s?.[sku]?.p;
  if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === "number" && n > 0)) return [];
  const fmt = (n: number) => `${english ? String(n) : String(n).replace(".", ",")} cm`;
  const section = english ? "Dimensions (assembled)" : "Dimensions (assemblé)";
  const names = english ? ["Width", "Depth", "Height"] : ["Largeur", "Profondeur", "Hauteur"];
  return p.map((n, i) => ({ section, name: names[i], value: fmt(n) }));
}

const HOUSE_BRANDS = [HOUSE_BRAND, HOUSE_BRAND_EN];

/** Brand to show: keep a real product vendor (Outsunny, …); replace empty, the supplier
 * name ("Aosom"), or our own house brand with the locale's house brand (FR "Ameublo
 * Direct", EN "Furnish Direct"). The brand must match the branding on the landing page
 * the offer links to, or the channel flags a brand/landing-page mismatch.
 *
 * The house-brand case is not hypothetical: Shopify's `vendor` field is set to
 * "Ameublo Direct" on 100% of products (250/250 sampled 2026-08-12). Without this branch
 * the "a real vendor wins" rule fires on our OWN name and the EN feed silently keeps the
 * FR brand — which is exactly what shipped in v0.5.59.1 and did nothing. */
function resolveBrand(
  vendor: string | null | undefined,
  houseBrand: string = HOUSE_BRAND,
): string {
  const v = (vendor ?? "").trim();
  if (!v || SUPPLIER_WORD.test(v)) return houseBrand;
  if (HOUSE_BRANDS.some((b) => b.toLowerCase() === v.toLowerCase())) return houseBrand;
  return v;
}

/** Pure: map raw Shopify products to feed items (one per variant SKU). Active only.
 * g:id (SKU) is deduplicated across the whole feed — a duplicate g:id makes Google
 * reject/merge unpredictably, and dropship catalogs do reuse SKUs.
 *
 * When `opts.preferEnglishTitle` is set the feed switches to the EN locale wholesale, not
 * just the title: the base title comes from `p.titleEn` (custom.title_en metafield, falling
 * back to the FR `p.title` when missing or blank), links point at furnishdirect.ca, and
 * the house brand becomes "Furnish Direct". Those three move together on purpose — an EN
 * title linking to a FR page, or a "Furnish Direct" brand on a page headed "Ameublo Direct",
 * is exactly the mismatch Pinterest/Google flag. Used by the Pinterest EN feed. */
export function shopifyToFeedItems(
  products: ShopifyFeedProduct[],
  opts: {
    preferEnglishTitle?: boolean;
    /**
     * Photo stems (imageUrlStem — Aosom hash, CDN/resize-agnostic) the vision classifier
     * verified carry a marketing/measurement overlay (image_compliance's
     * image_classifications cache, verdicts from Claude at pos-1 and/or Gemini for the rest
     * of the gallery — see vision-classifier.ts's classifyProductImageGemini). Checked
     * ALONGSIDE the free isSpecImageUrl keyword filter below, never instead of it: the
     * keyword filter catches an obvious case for $0, this catches everything the keyword
     * filter cannot (opaque Shopify-renamed filenames — confirmed 2026-10-01 that 0/2612
     * current catalog images carry a matching keyword).
     */
    nonCompliantStems?: ReadonlySet<string>;
    /**
     * Stems the classifier POSITIVELY verified as clean (compliant=1). When provided, an image
     * may appear as an ADDITIONAL image (the Meta carousel / Pinterest extras) only if it is in
     * this set — fail-closed. Before 2026-10-10 only known-bad stems were removed, so every
     * never-classified photo shipped: 2 048 secondary images, 67 % of them carrying text or
     * dimension drawings, reached the Meta carousel. The hero image keeps a fallback (see below).
     * Omit to keep the legacy fail-open behaviour (unit tests, ad-hoc callers).
     */
    verifiedStems?: ReadonlySet<string>;
    /** FR option value -> EN option value (Shopify EN translations of product option values, e.g. "Blanc crème" -> "Cream white"). EN feed only: variant titles, colour and size come out in English. */
    optionValueEn?: ReadonlyMap<string, string>;
    /** Google / Bing only: add product_highlight (description bullets) and product_detail
     * (assembled size from custom.lc_dims). Off for Meta/Pinterest/Reddit, whose specs
     * do not define these attributes. */
    rich?: boolean;
  } = {},
): FeedItem[] {
  const english = opts.preferEnglishTitle === true;
  const houseBrand = english ? HOUSE_BRAND_EN : HOUSE_BRAND;
  const storefrontBase = english ? EN_STOREFRONT_BASE_URL : STOREFRONT_BASE_URL;
  const items: FeedItem[] = [];
  const seenIds = new Set<string>();
  let dupCount = 0;
  let unpublishedCount = 0;
  for (const p of products) {
    if (p.status !== "active") continue;          // active status
    // Must be published to the Online Store *now* — an active product is only live on the
    // storefront when published_at is set AND not in the future. null = never published;
    // a future timestamp = a scheduled publish that isn't live yet. Either way
    // /products/{handle} 404s and Google Merchant flags "Product page unavailable", so
    // exclude it rather than ship a dead link.
    if (!p.published_at || new Date(p.published_at).getTime() > Date.now()) { unpublishedCount++; continue; }
    if (!p.handle) continue;
    const rawImages = (p.images ?? []).filter((i) => Boolean(i.src));
    if (rawImages.length === 0) continue;         // Google/Pinterest/Meta require an image
    // Drop spec/infographic/dimension-chart/marketing-overlay shots before this product's
    // images ever reach an ad feed. Two independent filters, both applied:
    //  1. isSpecImageUrl — free keyword match. Confirmed 2026-10-01 it matches 0/2612 current
    //     catalog images (Shopify renames every upload to an opaque hash), so it only guards
    //     a future/un-renamed URL. It ignores Shopify's `_<uuid>` re-upload suffix, whose hex
    //     produced "-c0" etc. by chance and dropped good colour photos (2026-10-21).
    //  2. nonCompliantStems — the vision classifier's verdict (image_classifications), the
    //     ONE signal that actually works against today's data. A parasol's
    //     additional_image_link carried an assembly diagram ("Detachable pole with spiral
    //     connection...") confirmed live; neither filter existed here until this pass.
    // Falls back to the unfiltered list on the (expected to be non-existent) case of a
    // product whose ENTIRE gallery is flagged, so a feed item never ships with no image.
    const nonCompliantStems = opts.nonCompliantStems;
    const cleanImages = rawImages.filter(
      (i) => !isSpecImageUrl(i.src, { ignoreShopifyUuid: true }) && !(nonCompliantStems?.has(imageUrlStem(i.src))),
    );
    const productImages = cleanImages.length > 0 ? cleanImages : rawImages;
    const images = productImages.map((i) => i.src);
    const verified = opts.verifiedStems;
    const isVerified = (src: string) => !verified || verified.has(imageUrlStem(src));
    // Hero: the first photo as before, unless it was never verified and a verified one exists.
    const heroSrc = isVerified(images[0]) ? images[0] : (images.find(isVerified) ?? images[0]);
    const link = `${storefrontBase}/products/${encodeURIComponent(p.handle)}`;
    const rawBody = english && p.bodyEn && p.bodyEn.trim() !== "" ? p.bodyEn : (p.body_html ?? "");
    const description = truncate(stripPromoText(scrubSupplier(stripHtml(rawBody), houseBrand)), DESCRIPTION_MAX);
    const highlights = opts.rich ? highlightsFromBody(rawBody, houseBrand) : [];
    const enMap = english ? opts.optionValueEn : undefined;
    const toEn = <T extends string | null | undefined>(s: T): T | string =>
      !enMap || !s ? s : String(s).split(" / ").map((part) => enMap.get(part.trim()) ?? part).join(" / ");
    const brand = resolveBrand(p.vendor, houseBrand);
    const cat = mapToGoogleCategory(p.product_type);
    const variants = (p.variants ?? []).filter((v) => v.sku && String(v.sku).trim() !== "");
    const multi = variants.length > 1;
    // EN feed: prefer custom.title_en; fall back to the FR title when it's absent/blank.
    const baseTitle =
      opts.preferEnglishTitle && p.titleEn && p.titleEn.trim() !== "" ? p.titleEn : p.title;

    for (const v of variants) {
      const price = parseFloat(v.price ?? "0") || 0;
      if (price <= 0) continue;
      const id = String(v.sku);
      if (seenIds.has(id)) { dupCount++; continue; } // dedup g:id across the feed
      seenIds.add(id);
      const cap = parseFloat(v.compare_at_price ?? "") || 0;
      const compareAtPrice = cap > price ? cap : null; // only a real "was" price counts
      // Dropship products are mostly untracked; treat untracked as in stock.
      const tracked = v.inventory_management != null && v.inventory_management !== "";
      const availability: FeedItem["availability"] =
        tracked && (v.inventory_quantity ?? 0) <= 0 ? "out of stock" : "in stock";
      // Differentiate variant titles when the product has real variants.
      const variantTitle = multi && v.title && v.title !== "Default Title" ? ` - ${toEn(v.title)}` : "";
      // Each variant is its own offer (g:id = SKU), so its image must show THAT variant — an
      // "Argent" item carrying the product's black hero photo is an image/variant mismatch.
      // Use the variant's assigned image; fall back to the product's first image only when it
      // has none (unchanged behaviour for every unassigned variant and single-variant product).
      const ownImage = v.image_id != null
        ? productImages.find((i) => i.id != null && String(i.id) === String(v.image_id))
        : undefined;
      // Deep-link multi-variant offers to their own variant so the landing page shows the
      // advertised colour/size, not the default one. Single-variant links stay bare.
      const variantLink = multi && v.id != null && String(v.id) !== ""
        ? `${link}?variant=${encodeURIComponent(String(v.id))}`
        : link;
      items.push({
        id,
        itemGroupId: multi ? String(p.id) : null,
        title: truncate(stripPromoText(stripImperialDimensions(scrubSupplier(`${baseTitle}${variantTitle}`, houseBrand))), 150),
        description,
        link: variantLink,
        imageLink: ownImage ? ownImage.src : heroSrc,
        // Secondary images are what the Meta carousel cycles through: only verified-clean ones.
        additionalImageLinks: images.filter((src) => src !== (ownImage ? ownImage.src : heroSrc) && isVerified(src)),
        price,
        compareAtPrice,
        availability,
        condition: "new",
        brand,
        // Colour for <g:color>. The Shopify "Couleur" option is the richer source (it
        // distinguishes "Gris foncé" from "Gris", which the 2-letter SKU suffix cannot), so
        // prefer it and fall back to the SKU suffix (COLOR_MAP) when the product has no
        // colour option. English option values are mapped to French for the FR market.
        color: toEn(frenchifyColor(optionValue(p, v, COLOUR_OPTION)) ?? parseSku(id).color) as string | null | undefined,
        // <g:size> from the Shopify "Taille" option. Values are Aosom's imperial dimension
        // strings; Google accepts free-form size text, and having it lets Shopping tell
        // same-product variants apart in the same item_group.
        size: toEn(optionValue(p, v, SIZE_OPTION)) as string | null | undefined,
        // <g:material> from a Shopify metafield only — never inferred. Product-level, so
        // every variant of a product shares it. Null today: no material metafield exists.
        material: materialFromMetafields(p.metafields),
        ...(opts.rich
          ? { highlights, details: dimensionDetails(p.metafields?.[DIMS_METAFIELD_KEY], id, english) }
          : {}),
        productType: p.product_type ?? "",
        googleCategoryId: cat.id,
      });
    }
  }
  if (unpublishedCount > 0) console.warn(`[FEED] excluded ${unpublishedCount} active products not published to the Online Store (storefront would 404)`);
  if (dupCount > 0) console.warn(`[FEED] skipped ${dupCount} variants with duplicate SKUs (g:id must be unique)`);
  return items;
}

function parseNextPageInfo(link: string | null): string | null {
  if (!link) return null;
  const part = link.split(",").find((s) => s.includes('rel="next"'));
  const m = part && /<([^>]+)>/.exec(part);
  return m ? new URL(m[1]).searchParams.get("page_info") : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retry/backoff for 429 + 5xx, honoring Retry-After (Shopify is ~2 req/s). */
async function fetchWithRetry(url: string, token: string, tries = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // Cache the (paginated) Shopify product data in Next's Data Cache, tagged 'feeds'.
    // revalidate=86400 keeps a 24h baseline; POST /api/revalidate calls
    // revalidateTag('feeds') to refresh on demand (e.g. right after a catalog sync).
    const res = await fetch(url, {
      headers: { "X-Shopify-Access-Token": token },
      next: { revalidate: 86400, tags: ["feeds"] },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "");
      const waitSec = !Number.isNaN(retryAfter) ? Math.min(retryAfter, 30) : Math.min(2 ** attempt, 20);
      await sleep(waitSec * 1000);
      continue;
    }
    return res;
  }
}

const MAX_PAGES = 80; // 80 * 250 = 20,000 variants — well above the catalog; guard against runaway

/** POST a GraphQL query with retry/backoff for 429 + 5xx + GraphQL THROTTLED errors. */
async function graphqlWithRetry(
  url: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  tries = 5,
): Promise<{ data?: unknown; errors?: Array<{ message: string; extensions?: { code?: string } }> }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "");
      const waitSec = !Number.isNaN(retryAfter) ? Math.min(retryAfter, 30) : Math.min(2 ** attempt, 20);
      await sleep(waitSec * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Shopify GraphQL fetch failed: ${res.status}`);
    const body = (await res.json()) as {
      data?: unknown;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };
    // GraphQL throttling comes back as HTTP 200 with a THROTTLED error code.
    const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < tries) {
      await sleep(Math.min(2 ** attempt, 20) * 1000);
      continue;
    }
    return body;
  }
}

/** Fetch a map of Shopify product id → custom.title_en metafield value (non-empty only).
 * REST products.json does not return metafields, so the EN title is resolved via GraphQL.
 * Note: this is a POST, which Next does not Data-Cache — so EN titles are always fetched
 * fresh and are NOT covered by the 'feeds' tag / POST /api/revalidate. Only the EN feed
 * (pinterest-en) pays this per regeneration. */
export async function fetchTitleEnMap(): Promise<Map<string, string>> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not configured");
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`;
  const query = `query TitleEn($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        legacyResourceId
        metafield(namespace: "custom", key: "title_en") { value }
      }
    }
  }`;
  const map = new Map<string, string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const body = await graphqlWithRetry(url, token, query, { cursor });
    if (body.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    const conn = (body.data as {
      products?: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ legacyResourceId: string; metafield: { value: string } | null }>;
      };
    })?.products;
    if (!conn) throw new Error("Shopify GraphQL returned no products connection");
    for (const node of conn.nodes) {
      const value = node.metafield?.value?.trim();
      if (value) map.set(String(node.legacyResourceId), value);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < MAX_PAGES);
  return map;
}

/** Fetch product-id -> English description HTML (custom.body_html_en). Same pass shape as fetchTitleEnMap. */
export async function fetchBodyEnMap(): Promise<Map<string, string>> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not configured");
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`;
  const query = `query BodyEn($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId metafield(namespace: "custom", key: "body_html_en") { value } }
    }
  }`;
  const map = new Map<string, string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const body = await graphqlWithRetry(url, token, query, { cursor });
    if (body.errors?.length) throw new Error(`Shopify GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
    const conn = (body.data as { products?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ legacyResourceId: string; metafield: { value: string } | null }> } })?.products;
    if (!conn) throw new Error("Shopify GraphQL returned no products connection");
    for (const node of conn.nodes) {
      const value = node.metafield?.value?.trim();
      if (value) map.set(String(node.legacyResourceId), value);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    pages++;
  } while (cursor && pages < MAX_PAGES * 3);
  return map;
}

/** FR option value -> EN option value, from Shopify EN translations of product option values. Never throws: a failure degrades to French option text, not a dead feed. */
export async function fetchOptionValueEnMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!token) return map;
    const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`;
    const query = `query OptEn($cursor: String) {
      translatableResources(first: 250, after: $cursor, resourceType: PRODUCT_OPTION_VALUE) {
        pageInfo { hasNextPage endCursor }
        nodes { translatableContent { key value } translations(locale: "en") { key value } }
      }
    }`;
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await graphqlWithRetry(url, token, query, { cursor });
      if (body.errors?.length) return map;
      const conn = (body.data as { translatableResources?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ translatableContent: Array<{ key: string; value: string }>; translations: Array<{ key: string; value: string }> }> } })?.translatableResources;
      if (!conn) return map;
      for (const n of conn.nodes) {
        const fr = n.translatableContent.find((c) => c.key === "name")?.value?.trim();
        const en = n.translations.find((t) => t.key === "name")?.value?.trim();
        if (fr && en && !map.has(fr)) map.set(fr, en);
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      pages++;
    } while (cursor && pages < 100);
  } catch (err) {
    console.warn("[FEED] option-value EN translations unavailable (non-fatal):", err);
  }
  return map;
}

/** Fetch product-id → material for whichever of MATERIAL_METAFIELD_KEYS is defined.
 *
 * Gated on a definition existing, so on a store with no material metafield (which is the
 * case today) this costs ONE cheap GraphQL call and never paginates. The moment someone
 * defines `custom.material`, the full pass turns on by itself. Returns an empty map — never
 * throws — because a missing material must degrade to an omitted attribute, not a dead feed.
 */
export async function fetchMaterialMap(): Promise<Map<string, string>> {
  const empty = new Map<string, string>();
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) return empty;
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`;

  try {
    const defs = await graphqlWithRetry(
      url,
      token,
      `{ metafieldDefinitions(first: 100, ownerType: PRODUCT) { nodes { namespace key } } }`,
      {},
    );
    const nodes =
      (defs.data as { metafieldDefinitions?: { nodes: Array<{ namespace: string; key: string }> } })
        ?.metafieldDefinitions?.nodes ?? [];
    const defined = new Set(nodes.map((n) => `${n.namespace}.${n.key}`));
    const wanted = MATERIAL_METAFIELD_KEYS.filter((k) => defined.has(k));
    if (wanted.length === 0) return empty; // nothing defined — skip the expensive pass

    const [namespace, key] = wanted[0].split(".");
    const query = `query Material($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { legacyResourceId metafield(namespace: "${namespace}", key: "${key}") { value } }
      }
    }`;
    const map = new Map<string, string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await graphqlWithRetry(url, token, query, { cursor });
      const conn = (body.data as {
        products?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ legacyResourceId: string; metafield: { value: string } | null }>;
        };
      })?.products;
      if (!conn) break;
      for (const node of conn.nodes) {
        const value = node.metafield?.value?.trim();
        if (value) map.set(String(node.legacyResourceId), value);
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      pages++;
    } while (cursor && pages < MAX_PAGES);
    return map;
  } catch {
    return empty; // never let a metafield lookup take the whole feed down
  }
}

/** Fetch product-id → raw custom.lc_dims JSON (the fit checker's per-SKU sizes). Rich feeds
 * only. Never throws: missing dimensions degrade to omitted product_detail rows. */
export async function fetchDimsMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) return map;
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`;
  const query = `query Dims($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { legacyResourceId metafield(namespace: "${FIT_DIMS_NAMESPACE}", key: "${FIT_DIMS_KEY}") { value } }
    }
  }`;
  try {
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await graphqlWithRetry(url, token, query, { cursor });
      const conn = (body.data as {
        products?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{ legacyResourceId: string; metafield: { value: string } | null }>;
        };
      })?.products;
      if (!conn) break;
      for (const node of conn.nodes) {
        const value = node.metafield?.value?.trim();
        if (value) map.set(String(node.legacyResourceId), value);
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      pages++;
    } while (cursor && pages < MAX_PAGES);
  } catch (err) {
    console.warn("[FEED] lc_dims lookup failed (non-fatal, product_detail omitted):", err);
  }
  return map;
}

/** Fetch all products from Shopify (paginated) and return feed items.
 * Pass `{ english: true }` to overlay custom.title_en titles for the Pinterest EN feed, and
 * `{ rich: true }` (Google, Bing) for product_highlight + product_detail. */
export async function getFeedItems(opts: { english?: boolean; rich?: boolean } = {}): Promise<FeedItem[]> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) throw new Error("SHOPIFY_ACCESS_TOKEN not configured");
  const base = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}`;
  const products: ShopifyFeedProduct[] = [];
  let pageInfo: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: "250", fields: "id,title,handle,vendor,status,product_type,body_html,images,variants,published_at,options" });
    if (pageInfo) params.set("page_info", pageInfo);
    const res = await fetchWithRetry(`${base}/products.json?${params}`, token);
    if (!res.ok) throw new Error(`Shopify products fetch failed: ${res.status}`);
    const data = (await res.json()) as { products: ShopifyFeedProduct[] };
    products.push(...data.products);
    pageInfo = parseNextPageInfo(res.headers.get("Link"));
    pages++;
  } while (pageInfo && pages < MAX_PAGES);

  // Fail loud rather than silently serve (and CDN-cache for 24h) a truncated catalog.
  if (pageInfo) throw new Error(`Feed pagination exceeded ${MAX_PAGES} pages — catalog larger than expected; refusing to serve a partial feed`);

  // Overlay <g:material> from its metafield. No-op (one cheap call) until one is defined.
  const materialMap = await fetchMaterialMap();
  if (materialMap.size > 0) {
    const [materialKey] = MATERIAL_METAFIELD_KEYS;
    for (const p of products) {
      const value = materialMap.get(String(p.id));
      if (value) p.metafields = { ...(p.metafields ?? {}), [materialKey]: value };
    }
  }

  if (opts.rich) {
    const dimsMap = await fetchDimsMap();
    for (const p of products) {
      const value = dimsMap.get(String(p.id));
      if (value) p.metafields = { ...(p.metafields ?? {}), [DIMS_METAFIELD_KEY]: value };
    }
  }

  if (opts.english) {
    const [titleEnMap, bodyEnMap, optionValueEn] = await Promise.all([fetchTitleEnMap(), fetchBodyEnMap().catch(() => new Map<string, string>()), fetchOptionValueEnMap()]);
    for (const p of products) {
      const en = titleEnMap.get(String(p.id));
      if (en) p.titleEn = en;
      const bodyEn = bodyEnMap.get(String(p.id));
      if (bodyEn) p.bodyEn = bodyEn;
    }
    const { nonCompliant, verified } = await fetchImageVerdictStems(products);
    return shopifyToFeedItems(products, { preferEnglishTitle: true, nonCompliantStems: nonCompliant, verifiedStems: verified, optionValueEn, rich: opts.rich });
  }

  const { nonCompliant, verified } = await fetchImageVerdictStems(products);
  return shopifyToFeedItems(products, { nonCompliantStems: nonCompliant, verifiedStems: verified, rich: opts.rich });
}

/** Bulk-load the vision classifier's verdicts (image_classifications) for every image in
 *  this fetch, keyed by stem, and return just the stems flagged non-compliant (marketing/
 *  measurement overlay). One extra Turso round trip for the whole feed, not per product —
 *  never lets a DB hiccup take the feed down (falls back to an empty set, same as "nothing
 *  classified yet"). See shopifyToFeedItems's nonCompliantStems doc comment. */
async function fetchImageVerdictStems(
  products: ShopifyFeedProduct[],
): Promise<{ nonCompliant: Set<string>; verified: Set<string> }> {
  const nonCompliant = new Set<string>();
  const verified = new Set<string>();
  try {
    const stems = products.flatMap((p) => (p.images ?? []).map((i) => imageUrlStem(i.src)).filter(Boolean));
    const verdicts = await getCachedImageVerdicts(stems);
    for (const [stem, v] of verdicts) (v.compliant ? verified : nonCompliant).add(stem);
  } catch (err) {
    // Fail-closed for secondary images: an empty `verified` set means no additional images,
    // the hero image still ships. Better a plain feed for 10 minutes than text-laden carousels.
    console.warn(`[FEED] vision-classification lookup failed (non-fatal, additional images withheld):`, err);
  }
  return { nonCompliant, verified };
}
