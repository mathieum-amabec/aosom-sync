import { NextResponse } from "next/server";
import { env } from "@/lib/config";

// Read PINTEREST_TAG_ID at request time (not build time) so the same deployment
// can have the tag toggled on by setting the env var, without a rebuild. This
// route is PUBLIC (allowlisted in proxy.ts) — Shopify's storefront fetches it
// via a ScriptTag, with no session. Mirror of /api/pixel/script (Meta).
export const dynamic = "force-dynamic";

const EMPTY_SCRIPT = "/* Pinterest Tag not configured (PINTEREST_TAG_ID unset) */\n";

/**
 * Build the Pinterest Tag storefront script. Loads the base tag and fires
 * `page` on every page, plus `pagevisit` (with product data) / `viewcategory` /
 * `search` / `addtocart` from Shopify storefront signals when available.
 * Checkout is fired by the Custom Web Pixel (docs/pinterest-custom-web-pixel.js),
 * because ScriptTags no longer run on the Checkout-Extensibility Thank-You page.
 * Every access to a storefront global is guarded so the script is inert on
 * pages/themes where those globals are absent.
 *
 * product_id everywhere = variant SKU, matching the Pinterest catalog feed whose
 * g:id is the SKU (e.g. "01-0901") — the same id used by the Meta pixel/catalog.
 */
function buildPinterestScript(tagId: string): string {
  // tagId is validated digits-only before interpolation (no injection).
  return `/* Pinterest Tag — injected by aosom-sync ScriptTag */
!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(
Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";
var t=document.createElement("script");t.async=!0,t.src=e;var r=
document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}(
"https://s.pinimg.com/ct/core.js");
pintrk('load', '${tagId}', { np: 'shopify' });
pintrk('page');

(function () {
  try {
    var meta = (window.ShopifyAnalytics && window.ShopifyAnalytics.meta) || {};
    var page = meta.page || {};
    var cur = (window.Shopify && window.Shopify.currency) || {};
    var currency = cur.active || 'CAD';
    // meta.product prices are base-currency cents; convert to the buyer's
    // presentment currency so value matches the currency label under
    // multi-currency / Shopify Markets (rate is 1 when no conversion applies).
    var rate = parseFloat(cur.rate || '1') || 1;
    function toMoney(cents) { return typeof cents === 'number' ? (cents / 100) * rate : undefined; }

    // product_id everywhere = variant SKU, to match the Pinterest catalog feed
    // whose g:id is the SKU (e.g. "01-0901") — NOT the numeric variant.id.
    // Pick the SELECTED variant (?variant= in the URL), falling back to the first.
    function pickVariant(product) {
      var variants = (product && product.variants) || [];
      var m = /[?&]variant=(\\d+)/.exec(window.location.search);
      if (m) {
        for (var i = 0; i < variants.length; i++) {
          if (String(variants[i].id) === m[1]) return variants[i];
        }
      }
      return variants[0] || {};
    }

    // pagevisit with product data — product pages (fuels retargeting audiences + DPA).
    if (page.pageType === 'product' && meta.product) {
      var p = meta.product;
      var variant = pickVariant(p);
      var val = toMoney(variant.price);
      var data = { currency: currency, product_category: p.type || '' };
      if (variant.sku) {
        data.line_items = [{ product_id: String(variant.sku), product_name: p.type || '', product_price: val, product_quantity: 1 }];
        if (val !== undefined) data.value = val;
      }
      pintrk('track', 'pagevisit', data);
    }

    // viewcategory — collection pages.
    if (page.pageType === 'collection') {
      pintrk('track', 'viewcategory', { currency: currency });
    }

    // search — search results page (?q=...).
    if (page.pageType === 'search') {
      var qm = /[?&]q=([^&]*)/.exec(window.location.search);
      var q = qm ? decodeURIComponent(qm[1].replace(/\\+/g, ' ')) : '';
      pintrk('track', 'search', { search_query: q });
    }

    // Checkout is fired by the Custom Web Pixel (Settings > Customer events),
    // not here: ScriptTags no longer run on the Checkout-Extensibility Thank-You
    // page. See docs/pinterest-custom-web-pixel.js.

    // addtocart — intercept storefront cart/add (form post and fetch/XHR to
    // /cart/add.js). Resolve the added variant's SKU + price from the meta
    // lookup so product_id matches the catalog; fall back to currency-only.
    var variantsById = {};
    (function () {
      var vs = (meta.product && meta.product.variants) || [];
      for (var i = 0; i < vs.length; i++) variantsById[String(vs[i].id)] = vs[i];
    })();

    // Themes that POST the <form> AND fetch /cart/add.js fire both handlers
    // below for a single click; collapse the pair so addtocart isn't counted
    // twice. The form (submit) path runs first and carries the SKU, so it wins.
    var lastAtcTs = 0;
    function fireAddToCart(variantId) {
      var now = Date.now();
      if (now - lastAtcTs < 1000) return;
      lastAtcTs = now;
      var v = variantId ? variantsById[String(variantId)] : null;
      var payload = { currency: currency, order_quantity: 1 };
      if (v && v.sku) {
        var val2 = toMoney(v.price);
        payload.line_items = [{ product_id: String(v.sku), product_price: val2, product_quantity: 1 }];
        if (val2 !== undefined) payload.value = val2;
      }
      pintrk('track', 'addtocart', payload);
    }

    document.addEventListener('submit', function (ev) {
      try {
        var form = ev.target;
        if (form && form.action && /\\/cart\\/add/.test(form.action)) {
          var idField = form.querySelector('[name="id"]');
          fireAddToCart(idField && idField.value);
        }
      } catch (e) {}
    }, true);

    if (window.fetch) {
      var _fetch = window.fetch;
      window.fetch = function () {
        try {
          var url = arguments[0];
          var href = typeof url === 'string' ? url : (url && url.url) || '';
          if (/\\/cart\\/add(\\.js)?/.test(href)) {
            var vid = null;
            var body = arguments[1] && arguments[1].body;
            if (body && typeof body.get === 'function') {
              vid = body.get('id');                             // FormData / URLSearchParams (Dawn)
            } else if (typeof body === 'string') {
              var jm = /"id"\\s*:\\s*"?(\\d+)"?/.exec(body);      // JSON body
              var um = /(?:^|&)id=(\\d+)/.exec(body);            // urlencoded body
              vid = (jm && jm[1]) || (um && um[1]) || null;
            }
            fireAddToCart(vid);
          }
        } catch (e) {}
        return _fetch.apply(this, arguments);
      };
    }
  } catch (e) { /* never break the storefront */ }
})();
`;
}

export async function GET() {
  const tagId = env.pinterestTagId;
  // Only digits are valid Pinterest Tag IDs; reject anything else to keep the
  // interpolation injection-proof even though the value is operator-controlled.
  const body = tagId && /^[0-9]+$/.test(tagId) ? buildPinterestScript(tagId) : EMPTY_SCRIPT;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Short cache so toggling the env var propagates within minutes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
