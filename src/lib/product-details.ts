/**
 * Product-page facts for the storefront assistant's `get_product_details` tool (2026-10-02):
 * dimensions, materials, assembly, weight capacity, sizes / colours — the questions shoppers
 * actually ask about furniture online ("will it fit?", "is it hard to assemble?").
 *
 * Read LIVE from the Shopify product (its description is the curated FR copy; the EN copy
 * lives in the `custom.body_html_en` metafield), so the assistant quotes the page the shopper
 * is about to buy from — never the raw Aosom feed. Cached 30 minutes per handle.
 */
import { shopifyFetch } from "@/lib/shopify-client";

export interface ProductDetails {
  title: string;
  /** Plain-text description, capped. */
  description: string;
  /** e.g. ["Taille: 10 x 15 pi, 11 x 15 pi", "Couleur: Gris"] */
  options: string[];
  /** Variant labels with their price, capped. */
  variants: Array<{ label: string; price: string }>;
}

const DESCRIPTION_MAX = 900;

/** Lines that carry the facts shoppers ask about (FR + EN). */
const SPEC_LINE = /dimension|largeur|hauteur|profondeur|longueur|diam[eè]tre|poids|charge|capacit|mat[ée]ri|assembl|montage|outil|entretien|nettoy|width|height|depth|length|weight|capacity|material|assembly|tools|care|\d\s?(po|cm|mm|pi|lb|kg|in|ft)\b|\d\s?"/i;

/**
 * The description trimmed to `max` chars with spec lines (dimensions, materials, assembly,
 * capacity, care) first, then the rest in order — the facts survive the cut, the marketing
 * copy goes. Cut from 1 500 to 900 chars on 2026-10-02: the details are re-sent on every later
 * step of the tool loop. Exported for tests.
 */
export function specFirst(text: string, max: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const ordered = [...lines.filter((l) => SPEC_LINE.test(l)), ...lines.filter((l) => !SPEC_LINE.test(l))];
  return ordered.join("\n").slice(0, max);
}
const TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { value: ProductDetails | null; expiry: number }>();

/** Description HTML → readable plain text, keeping list items and line breaks. Exported for tests. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Live product facts by storefront handle, or null when the product can't be read. */
export async function getProductDetails(handle: string, locale: "fr" | "en"): Promise<ProductDetails | null> {
  const key = `${locale}:${handle}`;
  const hit = cache.get(key);
  if (hit && hit.expiry > Date.now()) return hit.value;

  let value: ProductDetails | null = null;
  try {
    const res = await shopifyFetch(
      `/products.json?handle=${encodeURIComponent(handle)}&fields=id,title,body_html,options,variants`,
    );
    if (res.ok) {
      const data = (await res.json()) as {
        products?: Array<{
          id: number;
          title: string;
          body_html: string | null;
          options?: Array<{ name: string; values: string[] }>;
          variants?: Array<{ title: string; price: string }>;
        }>;
      };
      const p = data.products?.[0];
      if (p) {
        let body = p.body_html ?? "";
        if (locale === "en") {
          const mf = await shopifyFetch(`/products/${p.id}/metafields.json?namespace=custom&key=body_html_en`);
          if (mf.ok) {
            const m = (await mf.json()) as { metafields?: Array<{ value?: string }> };
            if (m.metafields?.[0]?.value) body = m.metafields[0].value;
          }
        }
        value = {
          title: p.title,
          description: specFirst(htmlToText(body), DESCRIPTION_MAX),
          options: (p.options ?? [])
            .filter((o) => o.name && o.name !== "Title")
            .map((o) => `${o.name}: ${o.values.join(", ")}`),
          variants: (p.variants ?? [])
            .slice(0, 12)
            .map((v) => ({ label: v.title, price: v.price }))
            .filter((v) => v.label && v.label !== "Default Title"),
        };
      }
    }
  } catch (err) {
    // Not cached: a network blip must not hide the product for 30 minutes.
    console.warn("[product-details] fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
  cache.set(key, { value, expiry: Date.now() + TTL_MS });
  return value;
}

/** Test-only: drop the cache. */
export function __clearProductDetailsCache(): void {
  cache.clear();
}
