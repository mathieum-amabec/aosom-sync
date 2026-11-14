/** CORS for public routes called from the Shopify storefront (same origins as /api/roue). */
export const STOREFRONT_ORIGINS = new Set([
  "https://ameublodirect.ca",
  "https://www.ameublodirect.ca",
  "https://furnishdirect.ca",
  "https://www.furnishdirect.ca",
  "https://27u5y2-kp.myshopify.com",
]);

/** Headers echoing an allow-listed Origin. Without `Access-Control-Allow-Origin` the caller is not a storefront. */
export function storefrontCors(origin: string | null, methods = "POST, OPTIONS"): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && STOREFRONT_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
