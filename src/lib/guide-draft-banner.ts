/**
 * The "BROUILLON" banner every pSEO guide draft carries in its Shopify body_html. It is a
 * review aid for the unpublished draft ONLY — it must never reach the live storefront.
 * Approval no longer involves a human editing the article in Shopify admin (the dashboard's
 * "Approuver" books a publish slot, see guide-scheduler.ts), so the banner is removed by the
 * queue publisher at publish time (queue-publisher.ts, shopify_guide branch).
 *
 * Kept in its own dependency-free module so the queue publisher can strip it without
 * importing the whole generator (Claude client, Shopify client, image resolver).
 */
export const DRAFT_BANNER_HTML = `<div style="border:2px solid #D4A853;background:#FFF8E7;color:#1A2340;padding:16px;margin-bottom:24px;border-radius:8px;font-family:sans-serif">
<strong>⚠️ BROUILLON — Ne pas publier sans relecture</strong><br>
L'introduction, la section « comment choisir » et la conclusion ci-dessous sont un premier jet généré par IA — à valider/ajuster par Mat avant toute mise en ligne. Les données produits (prix, stock, tendance) sont réelles et vérifiées automatiquement, pas générées.
</div>`;

/** Text that only ever appears inside the banner — used to detect a banner that survived. */
export const DRAFT_BANNER_MARKER = "BROUILLON — Ne pas publier";

/**
 * Removes the draft banner from a guide body. Tolerant of Shopify's own re-serialization of
 * body_html (attribute order/quoting, `<br>` vs `<br />`): it matches any single `<div>` whose
 * content (no nested div) contains the marker, rather than the exact literal above.
 */
export function stripGuideDraftBanner(bodyHtml: string): string {
  return bodyHtml.replace(/<div\b[^>]*>(?:(?!<\/?div\b)[^])*?BROUILLON — Ne pas publier(?:(?!<\/?div\b)[^])*?<\/div>\s*/g, "");
}

export function hasGuideDraftBanner(bodyHtml: string): boolean {
  return bodyHtml.includes(DRAFT_BANNER_MARKER);
}
