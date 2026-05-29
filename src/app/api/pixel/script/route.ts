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

    // ViewContent — product pages
    if (page.pageType === 'product' && meta.product) {
      var p = meta.product;
      var variant = (p.variants && p.variants[0]) || {};
      fbq('track', 'ViewContent', {
        content_type: 'product',
        content_ids: [String(variant.id || p.id || '')],
        content_name: p.type || '',
        value: variant.price ? variant.price / 100 : undefined,
        currency: (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'CAD'
      });
    }

    // Purchase — legacy order-status / thank-you page exposes Shopify.checkout
    if (window.Shopify && window.Shopify.checkout) {
      var c = window.Shopify.checkout;
      fbq('track', 'Purchase', {
        value: parseFloat(c.total_price || c.subtotal_price || 0),
        currency: c.currency || 'CAD',
        content_ids: (c.line_items || []).map(function (li) { return String(li.product_id || li.id); }),
        content_type: 'product'
      });
    }

    // AddToCart — intercept storefront cart/add (form post and fetch/XHR to /cart/add.js)
    var currency = (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) || 'CAD';
    document.addEventListener('submit', function (ev) {
      try {
        var form = ev.target;
        if (form && form.action && /\\/cart\\/add/.test(form.action)) {
          fbq('track', 'AddToCart', { currency: currency });
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
            fbq('track', 'AddToCart', { currency: currency });
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
