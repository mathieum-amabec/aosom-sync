import path from "path";
import { assertPublicHttpsUrl } from "./url-safety";

// This module used to also compose branded social images (product photo + SVG overlay
// via sharp). That path was removed when Job 4 switched to posting the raw Shopify
// lifestyle photo (Mat, 2026-07). What remains is the SSRF/DoS-guarded `downloadImage`
// (used by the slideshow / FFmpeg engines) and the `resolveImagePath` helper.

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB — guards against decompression-bomb / OOM
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// SSRF guard moved to the dependency-free ./url-safety so lighter modules (e.g.
// variant-merger) can use it without pulling image-composer's config graph.
// Re-exported here for backward compatibility with existing importers.
export { assertPublicHttpsUrl };

/** Read a response body into a Buffer, aborting if it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") || "0");
  if (declared > max) throw new Error(`Image too large: ${declared} bytes`);
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > max) throw new Error("Image exceeds size cap");
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error("Image exceeds size cap");
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Download a public image with SSRF + DoS protections: HTTPS-only, internal-host
 * denylist re-checked on every redirect hop, a request timeout, and a size cap.
 */
export async function downloadImage(url: string): Promise<Buffer> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicHttpsUrl(new URL(current));
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    // Follow redirects manually so the SSRF guard runs against each hop's host.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect ${res.status} without Location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
    return readCapped(res, MAX_IMAGE_BYTES);
  }
  throw new Error("Too many redirects while downloading image");
}

/**
 * Resolve an image path for reading (handles both /tmp and public/ paths).
 */
export function resolveImagePath(imagePath: string): string {
  if (imagePath.startsWith("/tmp/")) {
    // Prevent path traversal from /tmp/
    const resolved = path.resolve(imagePath);
    if (!resolved.startsWith("/tmp/")) throw new Error("Invalid image path");
    return resolved;
  }
  const resolved = path.resolve(process.cwd(), "public", imagePath);
  const publicDir = path.resolve(process.cwd(), "public");
  if (!resolved.startsWith(publicDir)) throw new Error("Invalid image path");
  return resolved;
}
