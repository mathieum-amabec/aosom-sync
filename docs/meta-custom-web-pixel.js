/*
 * Meta Pixel — Custom Web Pixel (Shopify Admin → Settings → Customer events → Add custom pixel)
 * =============================================================================================
 * WHY THIS EXISTS
 *   ameublodirect.ca runs Checkout Extensibility (plan Basic, checkout_api_supported=true).
 *   Since 2025-08-28, ScriptTags + additional_scripts NO LONGER execute on the Thank-You /
 *   Order-Status pages, and window.Shopify.checkout no longer exists there. The Purchase block
 *   in src/app/api/pixel/script/route.ts is therefore dead code — 0 Purchase events, ever.
 *   This Custom Web Pixel runs in Shopify's sandbox on ALL pages (checkout incl.) and fires
 *   Purchase from the checkout_completed event.
 *
 * DO NOT TOUCH the existing ScriptTag (id 222592598121). It keeps firing PageView / ViewContent
 * / AddToCart on the storefront. This pixel ONLY adds Purchase.
 *
 * content_ids = variant.sku  → matches the Meta catalog 384890002574549, whose retailer_id is
 *   the SKU (e.g. "01-0901"), NOT the Shopify variant.id. Verified against Shopify variant SKU.
 *
 * Pixel 214720653324969 is the WEB pixel. Do NOT use 2027065584856990 (mobile-app dataset).
 */

/* eslint-disable */
!(function (f, b, e, v, n, t, s) {
  if (f.fbq) return;
  n = f.fbq = function () {
    n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
  };
  if (!f._fbq) f._fbq = n;
  n.push = n;
  n.loaded = !0;
  n.version = "2.0";
  n.queue = [];
  t = b.createElement(e);
  t.async = !0;
  t.src = v;
  s = b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t, s);
})(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

fbq("init", "214720653324969");

analytics.subscribe("checkout_completed", (event) => {
  try {
    var checkout = event.data.checkout;
    var items = checkout.lineItems || [];

    // content_ids = variant SKU → matches Meta catalog retailer_id (e.g. "01-0901").
    var contentIds = items
      .map(function (li) {
        return li.variant && li.variant.sku;
      })
      .filter(Boolean);

    fbq(
      "track",
      "Purchase",
      {
        value: Number((checkout.totalPrice && checkout.totalPrice.amount) || 0),
        currency:
          (checkout.totalPrice && checkout.totalPrice.currencyCode) ||
          checkout.currencyCode ||
          "CAD",
        content_type: "product",
        content_ids: contentIds,
        contents: items.map(function (li) {
          return {
            id: li.variant && li.variant.sku,
            quantity: li.quantity,
            item_price:
              li.variant && li.variant.price
                ? Number(li.variant.price.amount)
                : undefined,
          };
        }),
        num_items: items.reduce(function (n, li) {
          return n + (li.quantity || 0);
        }, 0),
      },
      // eventID = checkout token → lets a future phase-2 Conversions API call
      // dedupe against this browser event (Order.checkout_token == checkout.token).
      { eventID: checkout.token },
    );
  } catch (e) {
    /* never break the checkout */
  }
});
