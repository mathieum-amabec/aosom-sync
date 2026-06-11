/**
 * SSRF/URL safety helpers. Pure (no config / no native deps) so any module can import
 * it without pulling heavier graphs.
 *
 * Reject any URL that is not plain HTTPS or whose host falls in a private/link-local/
 * internal range. Apply to the INITIAL url AND re-apply to every redirect hop — a
 * host-only check on the first URL is bypassable by an attacker-controlled 30x redirect
 * to an internal address (so callers should also disable auto-redirect or follow hops
 * manually and re-check).
 */
export function assertPublicHttpsUrl(url: URL): void {
  if (url.protocol !== "https:") throw new Error("Only HTTPS image URLs allowed");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]" ||
      host.startsWith("127.") || host.startsWith("10.") || host.startsWith("0.") ||
      host.startsWith("172.") || host.startsWith("192.168.") ||
      host === "169.254.169.254" || host.startsWith("169.254.") || host.startsWith("[") ||
      /^fe[89ab]/i.test(host) || /^fd/i.test(host) || /^fc/i.test(host) ||
      host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("Image URL points to internal network");
  }
}
