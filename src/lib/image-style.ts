/**
 * Lifestyle vs studio photo detection for AD images — pixels only, zero tokens.
 *
 * Mat's rule (2026-10-30): every Meta ad shows a LIFESTYLE photo, always. Catalog ads take
 * their picture from our feed's image_link, so the feed has to know which photos are
 * lifestyle. variant-merger's classifyImageBackground answers a softer question (import
 * ordering, "prefer lifestyle") with a border-only test, and that test calls ~40 % of studio
 * packshots "lifestyle" whenever the product touches the frame edge (a recliner, a fridge, a
 * trampoline filling the shot). Audit of the live Meta feed, 2026-10-30: the border test said
 * 3,466 lifestyle; a visual check found ~40 % of a sample were studio shots. Adding the
 * corner test below dropped that to 2,303 lifestyle with 38/40 sampled correct and 16/16
 * reclassified photos confirmed studio.
 *
 * Studio = the outer 10 % frame is mostly near-white, OR at least two 8×8 corner patches
 * (of a 100×100 thumbnail) are near-white. A real room photo almost never has two pure-white
 * corners; a packshot almost always does, even when the product touches the edges.
 */
import { assertPublicHttpsUrl } from "./url-safety";

export type AdImageStyle = "lifestyle" | "studio";

const SIZE = 100;
/** Border (outer 10 % frame) near-white fraction above which the photo is a packshot. */
export const STUDIO_BORDER_RATIO = 0.8;
/** A corner patch counts as white when this fraction of its pixels is near-white. */
const CORNER_WHITE_RATIO = 0.85;
const CORNER_PATCH = 8;
/** Two white corners are enough: lifestyle shots almost never have any. */
const STUDIO_MIN_WHITE_CORNERS = 2;
const NEAR_WHITE = 235;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;

/** Pure: classify a SIZE×SIZE raw RGB(A) thumbnail. Exported for tests. */
export function styleFromPixels(data: Uint8Array, channels: number): AdImageStyle {
  const white = (x: number, y: number) => {
    const i = (y * SIZE + x) * channels;
    return data[i] > NEAR_WHITE && data[i + 1] > NEAR_WHITE && data[i + 2] > NEAR_WHITE;
  };
  const band = Math.round(SIZE * 0.1);
  let border = 0;
  let borderWhite = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (x >= band && x < SIZE - band && y >= band && y < SIZE - band) continue;
      border++;
      if (white(x, y)) borderWhite++;
    }
  }
  if (borderWhite / border > STUDIO_BORDER_RATIO) return "studio";
  const far = SIZE - CORNER_PATCH;
  const corners = [[0, 0], [far, 0], [0, far], [far, far]].filter(([x0, y0]) => {
    let w = 0;
    for (let y = y0; y < y0 + CORNER_PATCH; y++) for (let x = x0; x < x0 + CORNER_PATCH; x++) if (white(x, y)) w++;
    return w / (CORNER_PATCH * CORNER_PATCH) > CORNER_WHITE_RATIO;
  }).length;
  return corners >= STUDIO_MIN_WHITE_CORNERS ? "studio" : "lifestyle";
}

/** Shopify's CDN resizes on the fly; a 200 px copy is plenty for a 100×100 test. */
function thumbnailUrl(url: string): string {
  if (!/(^|\.)cdn\.shopify\.com$/i.test(new URL(url).hostname)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}width=200`;
}

/**
 * Download a photo and classify it. Returns null when it cannot be decided (network error,
 * timeout, oversize, decode failure) — callers must treat null as "not known to be lifestyle",
 * never as lifestyle.
 */
export async function classifyAdImageStyle(url: string, fetchImpl: typeof fetch = fetch): Promise<AdImageStyle | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const target = new URL(thumbnailUrl(url));
    assertPublicHttpsUrl(target);
    const res = await fetchImpl(target.toString(), { signal: controller.signal, redirect: "error" });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    if (len && Number(len) > MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;
    const sharp = (await import("sharp")).default;
    const { data, info } = await sharp(buf)
      .resize(SIZE, SIZE, { fit: "fill" })
      // A transparent PNG packshot would otherwise read as black (transparent = 0,0,0,0)
      // and pass for lifestyle — the one mistake this classifier must not make.
      .flatten({ background: "#ffffff" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return styleFromPixels(data, info.channels);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
