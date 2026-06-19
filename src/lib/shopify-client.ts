import type { ShopifyExistingProduct, ShopifyExistingVariant } from "@/types/sync";
import type { AosomMergedProduct } from "@/types/aosom";
import { slugify, type GeneratedContent } from "./content-generator";
import { stripLeadingHeading } from "./html-utils";
import { env, SHOPIFY, SYNC } from "./config";
import { targetSellPrice } from "./pricing";

const SHOPIFY_FETCH_TIMEOUT_MS = 25_000;
const SHOPIFY_MAX_RETRIES = 3;
const SHOPIFY_MAX_RETRY_AFTER_S = 30;

export async function shopifyFetch(
  endpoint: string,
  options: RequestInit = {},
  retryCount = 0
): Promise<Response> {
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}${endpoint}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHOPIFY_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.shopifyAccessToken,
        ...options.headers,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Shopify request timeout after ${SHOPIFY_FETCH_TIMEOUT_MS / 1000}s: ${endpoint}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    if (retryCount >= SHOPIFY_MAX_RETRIES) {
      throw new Error(`Shopify rate limit exceeded after ${SHOPIFY_MAX_RETRIES} retries on ${endpoint}`);
    }
    const retryAfter = Math.min(
      parseFloat(response.headers.get("Retry-After") || "2"),
      SHOPIFY_MAX_RETRY_AFTER_S,
    );
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyFetch(endpoint, options, retryCount + 1);
  }

  return response;
}

/**
 * Fetch all products from Shopify (paginated).
 */
export async function fetchAllShopifyProducts(): Promise<ShopifyExistingProduct[]> {
  if (!env.hasShopifyToken) return [];

  const products: ShopifyExistingProduct[] = [];
  let pageInfo: string | null = null;

  do {
    const params = new URLSearchParams({
      limit: "250",
      fields: "id,title,status,variants,images,body_html,product_type,tags",
    });
    if (pageInfo) params.set("page_info", pageInfo);

    const response = await shopifyFetch(`/products.json?${params}`);
    if (!response.ok) throw new Error(`Shopify fetch failed: ${response.status}`);

    const data = await response.json();
    for (const p of data.products) {
      products.push(mapShopifyProduct(p));
    }

    pageInfo = parseLinkHeader(response.headers.get("Link"));
  } while (pageInfo);

  return products;
}

function mapShopifyProduct(raw: Record<string, unknown>): ShopifyExistingProduct {
  const variants = (raw.variants as Record<string, unknown>[]) || [];
  const images = (raw.images as Record<string, unknown>[]) || [];
  return {
    shopifyId: String(raw.id),
    title: (raw.title as string) || "",
    status: (raw.status as "active" | "draft" | "archived") || "active",
    bodyHtml: (raw.body_html as string) || "",
    productType: (raw.product_type as string) || "",
    // Shopify returns tags as a comma-separated string; normalize to a trimmed list.
    tags: typeof raw.tags === "string"
      ? raw.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [],
    images: images.map((img) => (img.src as string) || ""),
    variants: variants.map(
      (v): ShopifyExistingVariant => ({
        variantId: String(v.id),
        sku: (v.sku as string) || "",
        price: parseFloat(v.price as string) || 0,
        inventoryQuantity: (v.inventory_quantity as number) || 0,
        inventoryItemId: v.inventory_item_id != null ? String(v.inventory_item_id) : "",
        option1: (v.option1 as string) || null,
        option2: (v.option2 as string) || null,
        weight: parseFloat(v.weight as string) || 0,
        gtin: (v.barcode as string) || "",
      })
    ),
  };
}

/**
 * Create a Shopify product with FR primary + EN metafields.
 * Published live ('active') on import. No inventory tracking (dropship).
 */
export async function createShopifyProduct(
  merged: AosomMergedProduct,
  content: GeneratedContent
): Promise<{ id: string; handle: string }> {
  const hasColor = merged.variants.some((v) => v.color);
  const hasSize = merged.variants.some((v) => v.size);

  const options: { name: string }[] = [];
  if (hasColor) options.push({ name: "Couleur" });
  if (hasSize) options.push({ name: "Taille" });
  if (options.length === 0) options.push({ name: "Titre" });

  // Fall back to a title-derived slug if the model's handle slugified to empty;
  // an empty handle lets Shopify auto-generate one from the title.
  // De-brand the handle: the model sometimes embeds the supplier name "aosom" in
  // urlHandleFr/the title despite the "no-brand" prompt rule, which puts it in the
  // public URL. Strip it here so new imports don't re-introduce branded handles
  // (the existing 347 were fixed by scripts/fix-shopify-handles.mjs, PR #208). The
  // trailing trim guards against a leading/trailing dash when "aosom" was a prefix
  // or suffix (e.g. "aosom-x" → "x", "x-aosom" → "x").
  const handle = (content.urlHandleFr.trim() || slugify(content.titleFr))
    .replace(/(^|-)aosom(-|$)/gi, "$1$2")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");

  const payload = {
    product: {
      title: content.titleFr,
      ...(handle ? { handle } : {}),
      // Strip a leading marketing heading the model sometimes opens with (reads as a
      // duplicate title under the product H1). See html-utils.stripLeadingHeading.
      body_html: stripLeadingHeading(content.descriptionFr),
      // Public vendor field (surfaced in feeds + analytics) is always the store brand —
      // never the supplier. The real supplier brand is kept internally in the
      // `custom.brand_fr` metafield below. Matches the de-brand of existing products.
      vendor: "Ameublo Direct",
      product_type: merged.productType,
      // TODO(taxonomy): on a (re)creation, only generated tags are written here.
      // Manually-added taxonomy slugs (e.g. "bbq-cuisson", "rangement-exterieur")
      // are not part of content.tags, so they are lost if a product is recreated.
      // Once taxonomy tags are tracked (import job / products table), merge them in:
      // tags: [...new Set([...content.tags, ...taxonomyTags])].join(", ").
      // See docs/taxonomy-changelog.md. Non-blocking for the idempotency fix.
      tags: content.tags.join(", "),
      status: "active",
      options,
      variants: merged.variants.map((v) => ({
        sku: v.sku,
        // Floor at the Aosom price (0% markup, never below) — same rule as the sync. See pricing.ts.
        // Fall back to the raw price if the Aosom price is invalid (targetSellPrice → NaN),
        // so we never emit the string "NaN" to Shopify (bad CSV data is a separate concern).
        price: String(targetSellPrice(v.price) || v.price),
        inventory_management: null, // dropship — no inventory tracking
        requires_shipping: true,
        weight: v.weight,
        weight_unit: "kg",
        barcode: v.gtin,
        option1: hasColor
          ? v.color || "Défaut"
          : hasSize
            ? v.size || "Défaut"
            : "Titre par défaut",
        option2: hasColor && hasSize ? v.size || "Défaut" : undefined,
      })),
      images: merged.images.map((src) => ({ src })),
      metafields: [
        // Native Shopify SEO (store default locale = FR). EN equivalents kept in
        // custom.* for later translation (Translate & Adapt / GraphQL).
        {
          namespace: "global",
          key: "title_tag",
          value: content.metaTitleFr,
          type: "single_line_text_field",
        },
        {
          namespace: "global",
          key: "description_tag",
          value: content.metaDescriptionFr,
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: "title_en",
          value: content.titleEn,
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: "body_html_en",
          value: content.descriptionEn,
          type: "multi_line_text_field",
        },
        {
          namespace: "custom",
          key: "meta_title_en",
          value: content.metaTitleEn,
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: "meta_description_en",
          value: content.metaDescriptionEn,
          type: "single_line_text_field",
        },
        // Supplier brand — internal only, never shown to the customer.
        {
          namespace: "custom",
          key: "brand_fr",
          value: merged.brand || "Aosom",
          type: "single_line_text_field",
        },
        // Shopify 422s the entire product create on a blank single_line_text_field
        // value, so drop any metafield whose value is empty/undefined (e.g. an LLM
        // that returned "" for a meta field).
      ].filter((m) => typeof m.value === "string" && m.value.trim() !== ""),
    },
  };

  const response = await shopifyFetch("/products.json", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify create failed: ${response.status} — ${text}`);
  }

  const data = await response.json();
  return {
    id: String(data.product.id),
    handle: typeof data.product.handle === "string" ? data.product.handle : "",
  };
}

export async function updateShopifyProduct(
  shopifyId: string,
  updates: {
    title?: string;
    bodyHtml?: string;
    images?: string[];
    status?: "active" | "draft" | "archived";
    tags?: string[];
  }
): Promise<void> {
  const payload: Record<string, unknown> = { id: shopifyId };
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.bodyHtml !== undefined) payload.body_html = updates.bodyHtml;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.images !== undefined) {
    payload.images = updates.images.map((src) => ({ src }));
  }
  if (updates.tags !== undefined) payload.tags = updates.tags.join(", ");

  const response = await shopifyFetch(`/products/${shopifyId}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: payload }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify update failed: ${response.status} — ${text}`);
  }
}

export async function updateShopifyVariantPrice(
  variantId: string,
  price: number,
  oldPrice?: number
): Promise<void> {
  const variant: Record<string, unknown> = { id: variantId, price: String(price) };

  if (oldPrice !== undefined) {
    // Only show a struck-through "was" price for a real discount >= the configured
    // threshold (default 10%). A 1% dip no longer renders a fake sale. oldPrice > 0
    // guards against divide-by-zero; a price increase clears compare_at_price.
    const discountPct = oldPrice > 0 ? (oldPrice - price) / oldPrice : 0;
    variant.compare_at_price =
      price < oldPrice && discountPct >= SYNC.MIN_DISCOUNT_DISPLAY_PERCENT / 100
        ? String(oldPrice)
        : null;
  }

  const response = await shopifyFetch(`/variants/${variantId}.json`, {
    method: "PUT",
    body: JSON.stringify({ variant }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify variant update failed: ${response.status} — ${text}`);
  }
}

export async function draftShopifyProduct(shopifyId: string): Promise<void> {
  await updateShopifyProduct(shopifyId, { status: "draft" });
}

// ─── Inventory tracking ─────────────────────────────────────────────
// Dropship products historically shipped with `inventory_management: null`
// (untracked — see createShopifyProduct). To push a safety-buffered quantity we
// (1) resolve the store's primary location, (2) enable tracking on the variant's
// inventory item, and (3) set its available level at that location.

let _cachedLocationId: string | null = null;

/**
 * The store's primary location id (cached for the process). Prefers an active
 * location, falling back to the first returned. Needs the `read_locations` scope.
 */
export async function getPrimaryLocationId(): Promise<string> {
  if (_cachedLocationId) return _cachedLocationId;
  const response = await shopifyFetch("/locations.json");
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify locations fetch failed: ${response.status} — ${text}`);
  }
  const data = await response.json();
  const locations: Record<string, unknown>[] = data.locations || [];
  const chosen = locations.find((l) => l.active === true) ?? locations[0];
  if (!chosen) throw new Error("Shopify returned no locations");
  _cachedLocationId = String(chosen.id);
  return _cachedLocationId;
}

/**
 * Enable Shopify inventory tracking for a variant's inventory item. Idempotent —
 * re-running on an already-tracked item is a harmless no-op write. On API 2025-01
 * this is the supported path (writing `variant.inventory_management` is deprecated).
 * Needs the `write_inventory` scope.
 */
export async function enableVariantTracking(inventoryItemId: string): Promise<void> {
  const response = await shopifyFetch(`/inventory_items/${inventoryItemId}.json`, {
    method: "PUT",
    body: JSON.stringify({ inventory_item: { id: Number(inventoryItemId), tracked: true } }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify enable tracking failed (${inventoryItemId}): ${response.status} — ${text}`);
  }
}

/**
 * Set the absolute available quantity for an inventory item at a location. If the
 * item isn't stocked at the location yet, `set.json` 422s with a "not stocked"
 * error — connect it first (`connect.json`), then retry the set. Needs
 * `write_inventory` (and the item must already be tracked — see enableVariantTracking).
 */
export async function setInventoryLevel(
  inventoryItemId: string,
  locationId: string,
  available: number,
): Promise<void> {
  const body = JSON.stringify({
    location_id: Number(locationId),
    inventory_item_id: Number(inventoryItemId),
    available,
  });
  let response = await shopifyFetch("/inventory_levels/set.json", { method: "POST", body });

  if (response.status === 422) {
    const text = await response.text();
    // Item not connected to this location yet → connect, then retry the set once.
    if (/not stocked|connect/i.test(text)) {
      const connect = await shopifyFetch("/inventory_levels/connect.json", {
        method: "POST",
        body: JSON.stringify({ location_id: Number(locationId), inventory_item_id: Number(inventoryItemId) }),
      });
      if (!connect.ok) {
        const ctext = await connect.text();
        throw new Error(`Shopify inventory connect failed (${inventoryItemId}): ${connect.status} — ${ctext}`);
      }
      response = await shopifyFetch("/inventory_levels/set.json", { method: "POST", body });
    } else {
      throw new Error(`Shopify set inventory failed (${inventoryItemId}): 422 — ${text}`);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify set inventory failed (${inventoryItemId}): ${response.status} — ${text}`);
  }
}

/**
 * Add a product to a collection via the Collects API.
 */
export async function addProductToCollection(productId: string, collectionId: string): Promise<void> {
  const response = await shopifyFetch("/collects.json", {
    method: "POST",
    body: JSON.stringify({ collect: { product_id: Number(productId), collection_id: Number(collectionId) } }),
  });
  if (!response.ok) {
    const text = await response.text();
    // 422 = already in collection, not an error
    if (response.status === 422 && text.includes("already")) return;
    throw new Error(`Shopify collect failed: ${response.status} — ${text}`);
  }
}

/**
 * Get all collection IDs a product belongs to.
 */
export async function getProductCollections(productId: string): Promise<string[]> {
  const response = await shopifyFetch(`/collects.json?product_id=${productId}`);
  if (!response.ok) return [];
  const data = await response.json();
  return (data.collects || []).map((c: Record<string, unknown>) => String(c.collection_id));
}

/**
 * Fetch all custom collections from Shopify.
 */
export async function fetchAllCollections(): Promise<{ id: string; title: string; handle: string }[]> {
  const response = await shopifyFetch("/custom_collections.json?limit=250");
  if (!response.ok) return [];
  const data = await response.json();
  return (data.custom_collections || []).map((c: Record<string, unknown>) => ({
    id: String(c.id),
    title: c.title as string,
    handle: c.handle as string,
  }));
}

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return match ? match[1] : null;
}
