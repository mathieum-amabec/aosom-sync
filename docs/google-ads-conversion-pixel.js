/*
 * Google Ads Purchase — Custom Web Pixel (Shopify Admin → Settings → Customer events → Add custom pixel)
 * =====================================================================================================
 * WHY THIS EXISTS
 *   The "Google & YouTube" Shopify app already fires a purchase gtag event, but its web pixel
 *   (id 2268725353, apiClientId 1780363) is configured with google_tag_ids
 *   ["GT-W6NKNJQQ", "AW-18395711565"] — and AW-18395711565 belongs to a Google Ads account that
 *   is NOT under MCC 2953431617 and answers PERMISSION_DENIED. The account actually running the
 *   Shopping campaign is 6289357042, whose conversionTrackingId is 18406522701. It has received
 *   ZERO conversion events (segments.conversion_action returns 0 rows over 30 days).
 *   This Custom Web Pixel sends Purchase to the RIGHT account without touching the app.
 *   Verified 2026-09-01: the live theme 161562099817 contains no Google Ads code at all
 *   (426 assets scanned for AW-\d{9,} / gtag( / googletagmanager / googleadservices / send_to).
 *   Re-verified 2026-09-20 against the current live theme (162461843561): still 0 hits, and
 *   conversions are still 0 despite 148 real clicks over 30 days — the app pixel's destination
 *   has not been fixed.
 *
 * SANDBOX CONSTRAINT (why there is no gtag.js loader here)
 *   Custom pixels run in Shopify's "lax" sandbox: an iframe with sandbox="allow-scripts
 *   allow-forms" that CANNOT reach the top frame. gtag.js injects a script tag and reads the
 *   top-frame window/document — it has no real DOM to attach to and Shopify rejects it on save.
 *   The sandbox only guarantees: fetch (+ Headers/Request/Response), self, console, timers —
 *   plus Shopify's analytics / browser / init. So we send the event with fetch() straight to
 *   https://www.googleadservices.com/pagead/conversion/<id>/ — the same GET beacon Google ships
 *   as its <noscript> conversion pixel. No gtag, no DOM. Same approach as
 *   docs/meta-custom-web-pixel.js.
 *
 * ATTRIBUTION
 *   gclid is read from the _gcl_aw cookie ("GCL.<timestamp>.<gclid>") via Shopify's
 *   browser.cookie.get(). Without it Google still records the conversion but attributes it
 *   worse. oid = order id, so Google dedupes if the buyer reloads the thank-you page.
 *   This beacon does NOT support Enhanced Conversions (no hashed email) — repointing the
 *   Google & YouTube app at account 6289357042 remains the more complete fix.
 *
 * DO NOT touch custom pixel 140705897 (Meta Purchase) or 141656169 (Pinterest Checkout).
 */

/* eslint-disable */
var GADS_CONVERSION_ID = "18406522701"; // account 6289357042 "Ameublo Direct" (AW-18406522701)
var GADS_PURCHASE_LABEL = "VgxiCPOczuYcEM3-9MhE"; // conversion action 7731383923 "Purchase"

analytics.subscribe("checkout_completed", (event) => {
  try {
    var checkout = event.data.checkout;

    // ---- Data extraction ---------------------------------------------------------------
    var value = Number((checkout.totalPrice && checkout.totalPrice.amount) || 0);
    var currency = (checkout.totalPrice && checkout.totalPrice.currencyCode) || checkout.currencyCode || "CAD";
    // oid = order id when present, checkout token otherwise → Google dedupes on it.
    var orderId = (checkout.order && checkout.order.id) ? String(checkout.order.id) : (checkout.token || "");
    // Top-frame page URL via Shopify's context snapshot (window is the sandbox iframe, not the page).
    var pageUrl = (event.context && event.context.document && event.context.document.location && event.context.document.location.href) || "";

    // ---- Send: Google Ads /pagead/conversion GET beacon (noscript mechanism) ------------
    // Function EXPRESSION, not a declaration: a `function foo(){}` inside a block (this try{})
    // hoists inconsistently across engines, so linters flag it (no-inner-declarations) and
    // Shopify's pixel editor can refuse to save. Assigned before any call site below.
    var fire = function (gclid) {
      var params = {
        label: GADS_PURCHASE_LABEL,
        value: value,
        currency_code: currency,
        oid: orderId,
        url: pageUrl,
        guid: "ON",
        script: "0",
        num: "1",
        cv: "11",
        random: String(Date.now()),
      };
      if (gclid) params.gclid = gclid;

      var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");

      // no-cors: fire-and-forget beacon. The request reaches Google (which records the
      // conversion); we don't need to read the opaque response. keepalive lets it survive unload.
      // credentials:"include" is REQUIRED: fetch() defaults to credentials:"same-origin", which
      // sends NO cookies to googleadservices.com. Without Google's cookies AND without a gclid,
      // Google receives the hit but cannot attribute it to a click — the conversion is recorded
      // as unattributed and never shows against the campaign.
      fetch("https://www.googleadservices.com/pagead/conversion/" + GADS_CONVERSION_ID + "/?" + qs, { method: "GET", mode: "no-cors", credentials: "include", keepalive: true });
    };

    // _gcl_aw looks like "GCL.1788139428.Cj0KCQjw..." — everything after the 2nd dot is the gclid.
    var pending = null;
    try { pending = browser.cookie.get("_gcl_aw"); } catch (e) { pending = null; }

    if (pending && typeof pending.then === "function") {
      pending.then(function (raw) {
        var parts = raw ? String(raw).split(".") : [];
        fire(parts.length >= 3 ? parts.slice(2).join(".") : null);
      }).catch(function () { fire(null); });
    } else {
      fire(null);
    }
  } catch (e) {
    /* never break the checkout */
  }
});
