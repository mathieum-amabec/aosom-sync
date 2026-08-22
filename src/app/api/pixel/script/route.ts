import { NextResponse } from "next/server";
import { env } from "@/lib/config";

// Read NEXT_PUBLIC_META_PIXEL_ID at request time (not build time) so the same
// deployment can have the pixel toggled on by setting the env var, without a
// rebuild. This route is PUBLIC (allowlisted in proxy.ts) — Shopify's storefront
// fetches it via a ScriptTag, with no session.
export const dynamic = "force-dynamic";

const EMPTY_SCRIPT = "/* Meta Pixel not configured (NEXT_PUBLIC_META_PIXEL_ID unset) */\n";

/**
 * Build the Meta Pixel storefront script. Always fires PageView; fires
 * ViewContent / AddToCart / Purchase from Shopify storefront signals when
 * available. Every access to a storefront global is guarded so the script is
 * inert on pages/themes where those globals are absent.
 */
function buildPixelScript(pixelId: string): string {
  // pixelId is validated to be digits-only before interpolation (no injection).
  return `/* Meta Pixel — injected by aosom-sync ScriptTag */
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${pixelId}');
fbq('track', 'PageView');

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

    // content_ids everywhere = variant SKU, to match the Meta catalog whose
    // retailer_id is the SKU (e.g. "01-0901") — NOT the numeric variant.id.
    // ShopifyAnalytics.meta.product.variants[] carries { id, price, sku }.

    // Pick the SELECTED variant (?variant= in the URL), falling back to the
    // first variant. Avoids always reporting variants[0] on multi-variant PDPs.
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

    // ViewContent — product pages
    if (page.pageType === 'product' && meta.product) {
      var p = meta.product;
      var variant = pickVariant(p);
      fbq('track', 'ViewContent', {
        content_type: 'product',
        content_ids: variant.sku ? [String(variant.sku)] : [],
        content_name: p.type || '',
        value: toMoney(variant.price),
        currency: currency
      });
    }

    // Purchase is fired by the Custom Web Pixel (Settings > Customer events),
    // not here: ScriptTags no longer run on the Checkout-Extensibility
    // Thank-You page, so the old window.Shopify.checkout block was dead code.
    // See docs/meta-custom-web-pixel.js.

    // AddToCart — intercept storefront cart/add (form post and fetch/XHR to
    // /cart/add.js). Resolve the added variant's SKU + price from the meta
    // lookup so content_ids matches the catalog; fall back to currency-only.
    var variantsById = {};
    (function () {
      var vs = (meta.product && meta.product.variants) || [];
      for (var i = 0; i < vs.length; i++) variantsById[String(vs[i].id)] = vs[i];
    })();

    // Themes that POST the <form> AND fetch /cart/add.js fire both handlers
    // below for a single click; collapse the pair so AddToCart isn't counted
    // twice. The form (submit) path runs first and carries the SKU, so it wins.
    var lastAtcTs = 0;
    function fireAddToCart(variantId) {
      var now = Date.now();
      if (now - lastAtcTs < 1000) return;
      lastAtcTs = now;
      var v = variantId ? variantsById[String(variantId)] : null;
      var payload = { content_type: 'product', currency: currency };
      if (v && v.sku) {
        payload.content_ids = [String(v.sku)];
        var val = toMoney(v.price);
        if (val !== undefined) payload.value = val;
      }
      fbq('track', 'AddToCart', payload);
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
  const pixelId = env.metaPixelId;
  // Only digits are valid Meta Pixel IDs; reject anything else to keep the
  // interpolation injection-proof even though the value is operator-controlled.
  const body = pixelId && /^[0-9]+$/.test(pixelId) ? buildPixelScript(pixelId) : EMPTY_SCRIPT;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Short cache so toggling the env var propagates within minutes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
