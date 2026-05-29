/**
 * Meta (Facebook) Pixel installation on the Shopify storefront via the
 * Shopify ScriptTag REST API.
 *
 * Design: the ScriptTag points at our own dynamic endpoint
 * (`/api/pixel/script`), which emits the pixel JS at request time based on
 * NEXT_PUBLIC_META_PIXEL_ID. So the pixel ID lives in env (injected when
 * available) and the ScriptTag src is stable — install once, swap the ID via
 * env without touching Shopify. installPixel therefore takes the script URL,
 * not the pixel ID itself.
 *
 * Note on ScriptTags: Shopify loads ScriptTags on storefront pages (and the
 * legacy order-status page). For OS 2.0 themes some events rely on storefront
 * globals (ShopifyAnalytics, Shopify.checkout) which the script guards for.
 */

import { shopifyFetch } from "./shopify-client";

/** Path fragment that identifies a ScriptTag as ours (used for status/removal). */
export const PIXEL_SCRIPT_PATH = "/api/pixel/script";

export interface ShopifyScriptTag {
  id: number;
  src: string;
  event: string;
  created_at?: string;
  updated_at?: string;
}

export interface PixelStatus {
  installed: boolean;
  scriptTagId: number | null;
  src: string | null;
}

/** List the ScriptTags that point at our pixel script endpoint. */
async function findPixelScriptTags(): Promise<ShopifyScriptTag[]> {
  const res = await shopifyFetch("/script_tags.json?limit=250");
  if (!res.ok) {
    throw new Error(`Shopify script_tags list failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { script_tags?: ShopifyScriptTag[] };
  return (data.script_tags ?? []).filter(
    (t) => typeof t.src === "string" && t.src.includes(PIXEL_SCRIPT_PATH),
  );
}

/** Whether our pixel ScriptTag is currently installed on the store. */
export async function getPixelStatus(): Promise<PixelStatus> {
  const ours = await findPixelScriptTags();
  if (ours.length === 0) return { installed: false, scriptTagId: null, src: null };
  return { installed: true, scriptTagId: ours[0].id, src: ours[0].src };
}

/**
 * Install the pixel ScriptTag pointing at `scriptSrc`. Idempotent: removes any
 * existing pixel ScriptTags first so re-installing (e.g. after a domain change)
 * never leaves duplicates firing the pixel twice.
 */
export async function installPixel(scriptSrc: string): Promise<ShopifyScriptTag> {
  if (!scriptSrc || !/^https?:\/\//.test(scriptSrc)) {
    throw new Error(`installPixel: scriptSrc must be an absolute URL, got "${scriptSrc}"`);
  }
  await removePixel();
  const res = await shopifyFetch("/script_tags.json", {
    method: "POST",
    body: JSON.stringify({ script_tag: { event: "onload", src: scriptSrc } }),
  });
  if (!res.ok) {
    throw new Error(`Shopify script_tag create failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { script_tag: ShopifyScriptTag };
  return data.script_tag;
}

/** Remove all of our pixel ScriptTags. Returns the count removed. */
export async function removePixel(): Promise<number> {
  const ours = await findPixelScriptTags();
  let removed = 0;
  for (const tag of ours) {
    const res = await shopifyFetch(`/script_tags/${tag.id}.json`, { method: "DELETE" });
    if (res.ok) removed++;
    else console.warn(`[meta-pixel] failed to delete script_tag ${tag.id}: ${res.status}`);
  }
  return removed;
}
