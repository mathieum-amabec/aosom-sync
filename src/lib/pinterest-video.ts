/**
 * Studio Ameublo video -> Pinterest video Pin. Pure: no network, no DB.
 *
 * A Pin earns its keep through its clickable link (Pinterest is the one network where the link in the
 * post is followed), so a video with no product page to point at is NOT turned into a Pin — a
 * refusal with a reason, never a silent Pin to nowhere.
 */
import { SHOP_URL, STYLE_LABEL, type AmeubloStyle } from "./ameublo-caption";
import { stripSupplierBrands } from "./catalog-guard";
import type { VideoPinInput } from "./pinterest-client";

export interface StudioVideoForPin {
  id: number;
  lang: "fr" | "en" | null;
  style: string | null;
  label: string | null;
  caption: string | null;
  video_url: string;
  skus: string[];
}
export interface ProductForPin {
  /** Shopify handle of the product the video is about (its product page). */
  shopify_handle: string | null;
  /** A publicly reachable photo, used as the Pin's cover (Pinterest requires one). */
  image1: string | null;
}

export type PinMapping = { ok: true; input: VideoPinInput } | { ok: false; reason: string };

/**
 * The caption minus its links — the Pin's own link field replaces them. A "Canapé — 244,99 $ : https://…" line
 * keeps its text ("Canapé — 244,99 $"); a line that was only a URL disappears.
 */
export function pinDescription(caption: string): string {
  const out: string[] = [];
  for (const line of stripSupplierBrands(caption).split(/\r?\n/)) {
    if (!/https?:\/\//i.test(line)) {
      out.push(line); // includes blank lines: those are paragraph breaks
      continue;
    }
    const kept = line.replace(/\s*[:：]?\s*https?:\/\/\S+/gi, "").trim();
    if (kept) out.push(kept); // a line that held nothing but a link is dropped outright
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function studioVideoToPin(
  v: StudioVideoForPin,
  product: ProductForPin | null,
  opts: { coverImageUrl?: string } = {},
): PinMapping {
  if (!v.lang) return { ok: false, reason: "vidéo sans langue" };
  if (!v.video_url) return { ok: false, reason: "vidéo sans fichier" };
  if (!product?.shopify_handle) return { ok: false, reason: "aucune page produit à lier (pas de handle Shopify)" };
  const cover = opts.coverImageUrl ?? product.image1;
  if (!cover) return { ok: false, reason: "aucune image de couverture (Pinterest l'exige pour une vidéo)" };
  const styleName = v.style && v.style in STYLE_LABEL ? STYLE_LABEL[v.style as AmeubloStyle][v.lang] : "";
  const title = (v.label?.trim() || styleName || `Vidéo ${v.id}`).slice(0, 100);
  const description = pinDescription(v.caption ?? "");
  if (!description) return { ok: false, reason: "légende vide" };
  return {
    ok: true,
    input: {
      title,
      description,
      link: `${SHOP_URL[v.lang]}/products/${product.shopify_handle}`,
      videoUrl: v.video_url,
      coverImageUrl: cover,
      altText: title,
    },
  };
}
