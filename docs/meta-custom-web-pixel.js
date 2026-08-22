/*
 * Meta Pixel — Custom Web Pixel (Shopify Admin → Settings → Customer events → Add custom pixel)
 * =============================================================================================
 * WHY THIS EXISTS
 *   ameublodirect.ca runs Checkout Extensibility (plan Basic). Since 2025-08-28, ScriptTags no
 *   longer run on the Thank-You / Order-Status page, so the storefront pixel
 *   (src/app/api/pixel/script/route.ts) can't fire Purchase. This Custom Web Pixel fires it from
 *   the checkout_completed event. It ONLY adds Purchase; the ScriptTag keeps doing
 *   PageView / ViewContent / AddToCart. Do NOT touch ScriptTag id 222592598121.
 *
 * SANDBOX CONSTRAINT (why there is no Meta pixel SDK loader here)
 *   Custom pixels run in Shopify's "lax" sandbox: an iframe with sandbox="allow-scripts
 *   allow-forms" that CANNOT reach the top frame. The classic Meta pixel SDK loader (which
 *   injects a script tag into the page and scrapes the top-frame window/document) has no real
 *   DOM to attach to and Shopify rejects it on save. The sandbox only guarantees: fetch
 *   (+ Headers/Request/Response), self, console, timers — plus Shopify's analytics / browser / init.
 *   So we send the event with fetch() straight to Meta's tracking endpoint
 *   https://www.facebook.com/tr/ — the same GET beacon Meta ships as its <noscript> pixel.
 *   No SDK, no DOM.
 *
 * content_ids = variant.sku → matches the Meta catalog 384890002574549, whose retailer_id is
 *   the SKU (e.g. "01-0901"), NOT the Shopify variant.id.
 *
 * Pixel 214720653324969 is the WEB pixel. Do NOT use 2027065584856990 (mobile-app dataset).
 */

/* eslint-disable */
var META_PIXEL_ID = "214720653324969";

analytics.subscribe("checkout_completed", (event) => {
  try {
    var checkout = event.data.checkout;
    var items = checkout.lineItems || [];

    // ---- Data extraction (same fields as before; single-line to satisfy the pixel editor) ---
    // content_ids = variant SKU → matches Meta catalog retailer_id (e.g. "01-0901").
    var contentIds = items.map(function (li) { return li.variant && li.variant.sku; }).filter(Boolean);

    var contents = items.map(function (li) {
      var price = (li.variant && li.variant.price) ? Number(li.variant.price.amount) : null;
      return { id: li.variant && li.variant.sku, quantity: li.quantity, item_price: price };
    });

    var value = Number((checkout.totalPrice && checkout.totalPrice.amount) || 0);
    var currency = (checkout.totalPrice && checkout.totalPrice.currencyCode) || checkout.currencyCode || "CAD";
    var numItems = items.reduce(function (n, li) { return n + (li.quantity || 0); }, 0);
    // eventID = checkout token → lets a future phase-2 Conversions API call dedupe (Order.checkout_token == checkout.token).
    var eventId = checkout.token || "";
    // Top-frame page URL via Shopify's context snapshot (window is the sandbox iframe, not the page).
    var pageUrl = (event.context && event.context.document && event.context.document.location && event.context.document.location.href) || "";

    // ---- Send: Meta /tr GET beacon (noscript mechanism) ------------------------------------
    // Custom data goes as cd[<key>]; content_ids / contents are JSON-encoded.
    var params = {
      id: META_PIXEL_ID,
      ev: "Purchase",
      dl: pageUrl,
      eid: eventId,
      noscript: "1",
      "cd[value]": value,
      "cd[currency]": currency,
      "cd[content_type]": "product",
      "cd[content_ids]": JSON.stringify(contentIds),
      "cd[contents]": JSON.stringify(contents),
      "cd[num_items]": numItems,
    };

    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");

    // no-cors: fire-and-forget beacon. The request reaches Meta (which records the event); we
    // don't need to read the opaque response. keepalive lets it survive the page unload.
    fetch("https://www.facebook.com/tr/?" + qs, { method: "GET", mode: "no-cors", keepalive: true });
  } catch (e) {
    /* never break the checkout */
  }
});
