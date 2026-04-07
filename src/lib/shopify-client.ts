import type { ShopifyExistingProduct, ShopifyExistingVariant } from "@/types/sync";
import type { AosomMergedProduct } from "@/types/aosom";
import type { GeneratedContent } from "./content-generator";
import { env, SHOPIFY } from "./config";

async function shopifyFetch(
  endpoint: string,
  options: RequestInit = {},
  retryCount = 0
): Promise<Response> {
  const MAX_RETRIES = 3;
  const url = `https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.shopifyAccessToken,
      ...options.headers,
    },
  });

  if (response.status === 429) {
    if (retryCount >= MAX_RETRIES) {
      throw new Error(`Shopify rate limit exceeded after ${MAX_RETRIES} retries on ${endpoint}`);
    }
    const retryAfter = parseFloat(response.headers.get("Retry-After") || "2");
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
      fields: "id,title,status,variants,images,body_html,product_type",
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
    images: images.map((img) => (img.src as string) || ""),
    variants: variants.map(
      (v): ShopifyExistingVariant => ({
        variantId: String(v.id),
        sku: (v.sku as string) || "",
        price: parseFloat(v.price as string) || 0,
        inventoryQuantity: (v.inventory_quantity as number) || 0,
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
 * Imported as draft for manual review. No inventory tracking (dropship).
 */
export async function createShopifyProduct(
  merged: AosomMergedProduct,
  content: GeneratedContent
): Promise<string> {
  const hasColor = merged.variants.some((v) => v.color);
  const hasSize = merged.variants.some((v) => v.size);

  const options: { name: string }[] = [];
  if (hasColor) options.push({ name: "Couleur" });
  if (hasSize) options.push({ name: "Taille" });
  if (options.length === 0) options.push({ name: "Titre" });

  const payload = {
    product: {
      title: content.titleFr,
      body_html: content.descriptionFr,
      vendor: "Aosom",
      product_type: merged.productType,
      tags: content.tags.join(", "),
      status: "draft",
      options,
      variants: merged.variants.map((v) => ({
        sku: v.sku,
        price: String(v.price),
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
          key: "meta_description_fr",
          value: content.seoDescriptionFr,
          type: "single_line_text_field",
        },
        {
          namespace: "custom",
          key: "meta_description_en",
          value: content.seoDescriptionEn,
          type: "single_line_text_field",
        },
      ],
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
  return String(data.product.id);
}

export async function updateShopifyProduct(
  shopifyId: string,
  updates: {
    title?: string;
    bodyHtml?: string;
    images?: string[];
    status?: "active" | "draft" | "archived";
  }
): Promise<void> {
  const payload: Record<string, unknown> = { id: shopifyId };
  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.bodyHtml !== undefined) payload.body_html = updates.bodyHtml;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.images !== undefined) {
    payload.images = updates.images.map((src) => ({ src }));
  }

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
    variant.compare_at_price = price < oldPrice ? String(oldPrice) : null;
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

function parseLinkHeader(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return match ? match[1] : null;
}
