/**
 * Price guard for sequential ads (2026-10-02, Mat's choice "Vérif + re-rendu").
 *
 * The 4-message ads burn the product price into the video frame ("79,99 $ LIVRÉ CHEZ VOUS").
 * Prices move almost daily (43 of 61 seasonal drafts were already stale that day), and the
 * renderer runs on the operator's PC (ffmpeg + music + source clips), so the site cannot
 * re-render on its own. Instead:
 *
 *   - the renderer records the price it burned in the queue row's metadata (`renderedPrice`);
 *   - approval REFUSES an ad whose price changed since the render, and flags it
 *     `needsRerender` (sequential-ad-approval.ts);
 *   - the publisher re-checks right before posting and, on a change, puts the ad back to
 *     `draft` flagged `needsRerender` instead of publishing a wrong price (queue-publisher.ts);
 *   - `scripts/rerender-stale-sequential-ads.mts` re-renders every flagged / stale draft in
 *     place with the price of the day.
 *
 * "Current price" is the catalogue price the renderer itself reads (products.price), so the
 * comparison is like for like.
 */
import { getProduct } from "@/lib/database";

/** content_id is "seqad:<style>:<campaign>:<sku>" (everything after the 3rd colon is the sku). */
export function skuFromContentId(contentId: string): string | null {
  const parts = contentId.split(":");
  return parts.length >= 4 && parts[0] === "seqad" ? parts.slice(3).join(":") : null;
}

export function renderedPriceOf(metadata: Record<string, unknown> | null | undefined): number | null {
  const v = metadata?.renderedPrice;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const samePrice = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

export const priceFr = (n: number): string =>
  `${n.toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

export interface PriceCheck {
  /** false only when we KNOW the burned price differs from today's. */
  ok: boolean;
  rendered: number | null;
  current: number | null;
  reason?: string;
}

/**
 * Compare the price burned into an ad with today's catalogue price. Unknown (no recorded price,
 * product gone) → ok: the guard only blocks on a proven mismatch, never on missing data.
 */
export async function checkSequentialAdPrice(item: {
  contentId: string;
  metadata: Record<string, unknown> | null;
}): Promise<PriceCheck> {
  const rendered = renderedPriceOf(item.metadata);
  if (rendered == null) return { ok: true, rendered, current: null };
  const sku = skuFromContentId(item.contentId ?? "");
  if (!sku) return { ok: true, rendered, current: null };
  const product = await getProduct(sku);
  const current = product && Number.isFinite(product.price) ? Number(product.price) : null;
  if (current == null) return { ok: true, rendered, current };
  if (samePrice(rendered, current)) return { ok: true, rendered, current };
  return {
    ok: false,
    rendered,
    current,
    reason: `Prix changé depuis le rendu : ${priceFr(rendered)} → ${priceFr(current)}. À re-rendre avec le prix du jour.`,
  };
}
