/*
 * Pinterest Tag — Custom Web Pixel (Shopify Admin → Settings → Customer events → Add custom pixel)
 * =================================================================================================
 * WHY THIS EXISTS
 *   ameublodirect.ca runs Checkout Extensibility (plan Basic). Since 2025-08-28, ScriptTags no
 *   longer run on the Thank-You / Order-Status page, so the storefront Pinterest tag
 *   (src/app/api/pixel/pinterest-script/route.ts) can't fire the `checkout` conversion. This
 *   Custom Web Pixel fires it from the checkout_completed event. It ONLY adds `checkout`; the
 *   ScriptTag keeps doing page / pagevisit / viewcategory / search / addtocart. This mirrors the
 *   Meta setup exactly (docs/meta-custom-web-pixel.js).
 *
 * SANDBOX CONSTRAINT (why there is no Pinterest tag SDK loader here)
 *   Custom pixels run in Shopify's "lax" sandbox: an iframe with sandbox="allow-scripts
 *   allow-forms" that CANNOT reach the top frame. The Pinterest tag SDK (s.pinimg.com/ct/core.js,
 *   which injects a script tag and scrapes the top-frame window/document) has no real DOM to
 *   attach to and Shopify rejects it on save. The sandbox only guarantees: fetch (+ Headers/
 *   Request/Response), self, console, timers — plus Shopify's analytics / browser / init.
 *   So we send the event with fetch() straight to Pinterest's tracking endpoint
 *   https://ct.pinterest.com/v3/ — the same GET beacon Pinterest ships as its <noscript> tag.
 *   No SDK, no DOM.
 *
 * product_id / content_ids = variant.sku → matches the Pinterest catalog feed whose g:id is the
 *   SKU (e.g. "01-0901") — the same id the Meta pixel/catalog uses. NOT the numeric variant.id.
 *
 * SETUP — replace PINTEREST_TAG_ID below with the numeric Tag ID from Pinterest Ads Manager
 *   (Ads → Conversions → the tag), then paste this whole file into the custom pixel editor and
 *   Save. It must match the PINTEREST_TAG_ID env var used by the ScriptTag route so both halves
 *   report to the same tag.
 *
 * OPTIONAL (enhanced match / CAPI dedup, a later phase):
 *   - Enhanced match: add pd[em] = SHA-256 of the lowercased buyer email for better attribution.
 *     Omitted here (SubtleCrypto is not guaranteed in the lax sandbox) — mirror Meta, keep it simple.
 *   - event_id below = checkout token → lets a future server-side Conversions API call dedupe
 *     against this browser event (send the same event_id from both).
 */

/* eslint-disable */
var PINTEREST_TAG_ID = "PINTEREST_TAG_ID"; // <-- replace with the numeric Pinterest Tag ID

analytics.subscribe("checkout_completed", (event) => {
  try {
    var checkout = event.data.checkout;
    var items = checkout.lineItems || [];

    // ---- Data extraction (single-line to satisfy the pixel editor) --------------------------
    // content_ids = variant SKU → matches the Pinterest catalog g:id (e.g. "01-0901").
    var contentIds = items.map(function (li) { return li.variant && li.variant.sku; }).filter(Boolean);

    var lineItems = items.map(function (li) {
      var price = (li.variant && li.variant.price) ? Number(li.variant.price.amount) : null;
      return { product_id: li.variant && li.variant.sku, product_quantity: li.quantity, product_price: price };
    });

    var value = Number((checkout.totalPrice && checkout.totalPrice.amount) || 0);
    var currency = (checkout.totalPrice && checkout.totalPrice.currencyCode) || checkout.currencyCode || "CAD";
    var numItems = items.reduce(function (n, li) { return n + (li.quantity || 0); }, 0);
    var orderId = (checkout.order && checkout.order.id) || checkout.token || "";
    // event_id = checkout token → future Conversions API dedupe key.
    var eventId = checkout.token || "";

    // ---- Send: Pinterest /v3 GET beacon (noscript mechanism) --------------------------------
    // Event data goes as ed[<key>]; content_ids / line_items are JSON-encoded.
    var params = {
      tid: PINTEREST_TAG_ID,
      event: "checkout",
      event_id: eventId,
      noscript: "1",
      "ed[value]": value,
      "ed[currency]": currency,
      "ed[order_id]": orderId,
      "ed[order_quantity]": numItems,
      "ed[content_ids]": JSON.stringify(contentIds),
      "ed[line_items]": JSON.stringify(lineItems),
    };

    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");

    // no-cors: fire-and-forget beacon. The request reaches Pinterest (which records the event); we
    // don't need to read the opaque response. keepalive lets it survive the page unload.
    fetch("https://ct.pinterest.com/v3/?" + qs, { method: "GET", mode: "no-cors", keepalive: true });
  } catch (e) {
    /* never break the checkout */
  }
});
