/**
 * HTML helpers for product descriptions (body_html).
 */

/**
 * Remove a single leading heading (`<h1>`/`<h2>`/`<h3>`) from the start of an HTML
 * description. Claude-generated descriptions sometimes open with a marketing heading
 * right under the product `<h1>` (e.g. `<h3>Transformez votre espace…</h3>`), which reads
 * as a duplicate/second title on the PDP. This strips that opening heading and keeps the
 * rest of the description intact.
 *
 * Idempotent: descriptions that don't start with a heading are returned unchanged.
 * Only the FIRST element is removed (later in-body headings are legitimate structure).
 */
export function stripLeadingHeading(html: string | null | undefined): string {
  if (!html) return html ?? "";
  // Optional leading whitespace, then <hN ...> … </hN> (same N), then trailing whitespace.
  return html.replace(/^\s*<h([1-3])\b[^>]*>[\s\S]*?<\/h\1>\s*/i, "");
}
