/**
 * Pinterest Tag installation on the Shopify storefront via the Shopify
 * ScriptTag REST API. Mirror of meta-pixel.ts.
 *
 * Design: the ScriptTag points at our own dynamic endpoint
 * (`/api/pixel/pinterest-script`), which emits the Pinterest JS at request time
 * based on PINTEREST_TAG_ID. So the tag ID lives in env (injected when
 * available) and the ScriptTag src is stable — install once, swap the ID via env
 * without touching Shopify. installPinterestPixel therefore takes the script URL,
 * not the tag ID itself.
 *
 * Note on ScriptTags: Shopify loads ScriptTags on storefront pages (not the
 * Checkout-Extensibility Thank-You page). Checkout is fired by the Custom Web
 * Pixel — see docs/pinterest-custom-web-pixel.js.
 */

import { shopifyFetch } from "./shopify-client";
import type { ShopifyScriptTag, PixelStatus } from "./meta-pixel";

/** Path fragment that identifies a ScriptTag as our Pinterest tag (status/removal). */
export const PINTEREST_SCRIPT_PATH = "/api/pixel/pinterest-script";

/** List the ScriptTags that point at our Pinterest script endpoint. */
async function findPinterestScriptTags(): Promise<ShopifyScriptTag[]> {
  const res = await shopifyFetch("/script_tags.json?limit=250");
  if (!res.ok) {
    throw new Error(`Shopify script_tags list failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { script_tags?: ShopifyScriptTag[] };
  return (data.script_tags ?? []).filter(
    (t) => typeof t.src === "string" && t.src.includes(PINTEREST_SCRIPT_PATH),
  );
}

/** Whether our Pinterest ScriptTag is currently installed on the store. */
export async function getPinterestPixelStatus(): Promise<PixelStatus> {
  const ours = await findPinterestScriptTags();
  if (ours.length === 0) return { installed: false, scriptTagId: null, src: null };
  return { installed: true, scriptTagId: ours[0].id, src: ours[0].src };
}

/**
 * Install the Pinterest ScriptTag pointing at `scriptSrc`. Idempotent: removes
 * any existing Pinterest ScriptTags first so re-installing (e.g. after a domain
 * change) never leaves duplicates firing the tag twice.
 */
export async function installPinterestPixel(scriptSrc: string): Promise<ShopifyScriptTag> {
  if (!scriptSrc || !/^https?:\/\//.test(scriptSrc)) {
    throw new Error(`installPinterestPixel: scriptSrc must be an absolute URL, got "${scriptSrc}"`);
  }
  await removePinterestPixel();
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

/** Remove all of our Pinterest ScriptTags. Returns the count removed. */
export async function removePinterestPixel(): Promise<number> {
  const ours = await findPinterestScriptTags();
  let removed = 0;
  for (const tag of ours) {
    const res = await shopifyFetch(`/script_tags/${tag.id}.json`, { method: "DELETE" });
    if (res.ok) removed++;
    else console.warn(`[pinterest-pixel] failed to delete script_tag ${tag.id}: ${res.status}`);
  }
  return removed;
}
