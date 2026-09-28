/** Shopify Admin GraphQL reads for the Studio (titles, thumbnails, full galleries). */
import { env, SHOPIFY } from "@/lib/config";

async function shopifyGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://${SHOPIFY.STORE}/admin/api/${SHOPIFY.API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": env.shopifyAccessToken },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors ?? "no data").slice(0, 300)}`);
  return json.data;
}

export const productGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`);
export const productNumericId = (id: string) => id.replace("gid://shopify/Product/", "");

export interface ProductSummary {
  id: string;
  title: string;
  status: string;
  handle: string;
  thumbnail: string | null;
  imageCount: number;
}

/** One request for up to 100 products: FR title, status, first image, image count. */
export async function fetchProductSummaries(ids: string[]): Promise<Map<string, ProductSummary>> {
  const out = new Map<string, ProductSummary>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(productGid);
    const data = await shopifyGraphql<{
      nodes: ({ id: string; title: string; status: string; handle: string; featuredImage: { url: string } | null; mediaCount: { count: number } | null } | null)[];
    }>(
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title status handle featuredImage { url } mediaCount { count } } } }`,
      { ids: chunk },
    );
    for (const n of data.nodes) {
      if (!n?.id) continue;
      out.set(productNumericId(n.id), {
        id: productNumericId(n.id),
        title: n.title,
        status: n.status,
        handle: n.handle,
        thumbnail: n.featuredImage?.url ?? null,
        imageCount: n.mediaCount?.count ?? 0,
      });
    }
  }
  return out;
}

export interface GalleryImage {
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
}

/** The product's full Shopify gallery (cdn.shopify.com — Aosom CDN URLs 403 the renderer). */
export async function fetchProductGallery(id: string): Promise<{ title: string; handle: string; images: GalleryImage[] } | null> {
  const data = await shopifyGraphql<{
    product: { title: string; handle: string; images: { nodes: { url: string; width: number | null; height: number | null; altText: string | null }[] } } | null;
  }>(`query($id: ID!) { product(id: $id) { title handle images(first: 50) { nodes { url width height altText } } } }`, { id: productGid(id) });
  if (!data.product) return null;
  return {
    title: data.product.title,
    handle: data.product.handle,
    images: data.product.images.nodes.map((n) => ({ url: n.url, width: n.width, height: n.height, alt: n.altText })),
  };
}
