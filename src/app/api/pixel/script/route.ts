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
function buildPixelScript(pixelId: string, capiUrl: string): string {
  // pixelId is validated to be digits-only before interpolation (no injection).
  // 2026-11-12 (mobile perf audit): fbevents.js (~210 KB, ~450 ms of main-thread work on a mid phone) used to load
  // the moment this ScriptTag ran, competing with the hero image. The fbq stub still queues every call right away;
  // the SDK itself now loads on the first interaction, or 1.5 s after the page's load event, whichever comes first.
  // PageView is relayed to the Conversions API too (same eventID, Meta de-duplicates), so a visitor who leaves
  // before the SDK arrives is still counted server-side.
  return `/* Meta Pixel — injected by aosom-sync ScriptTag */
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];f.__lcFbLazy=1;
function go(){if(f.__lcFbGo)return;f.__lcFbGo=1;t=b.createElement(e);t.async=!0;t.src=v;
t.onload=function(){f.__lcFbReady=1;try{b.dispatchEvent(new Event('lc:fb-ready'))}catch(x){}};
s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
['pointerdown','keydown','touchstart','scroll'].forEach(function(k){f.addEventListener(k,go,{once:true,passive:true})});
if(b.readyState==='complete')setTimeout(go,1500);else f.addEventListener('load',function(){setTimeout(go,1500)})}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${pixelId}');

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

    // Conversions API: each browser event gets an id, passed to fbq as eventID and relayed
    // server-side to /api/capi/event with the same event_id so Meta de-duplicates the pair.
    // The relay is a no-op server-side until settings.capi_enabled = 1.
    function uid() {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }
    function cookie(n) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function currentFbc() {
      var fbc = cookie('_fbc');
      if (!fbc) {
        var q = /[?&]fbclid=([^&#]+)/.exec(window.location.search);
        if (q) fbc = 'fb.1.' + Date.now() + '.' + q[1];
      }
      return fbc;
    }
    function track(name, data) {
      var id = uid();
      fbq('track', name, data, { eventID: id });
      try {
        var body = JSON.stringify({
          event_name: name, event_id: id, event_source_url: window.location.href,
          fbp: cookie('_fbp'), fbc: currentFbc(), custom_data: data
        });
        var url = '${capiUrl}';
        if (navigator.sendBeacon) navigator.sendBeacon(url, body);
        else fetch(url, { method: 'POST', body: body, keepalive: true, mode: 'cors' }).catch(function () {});
      } catch (e) {}
    }

    // Browser PageView (queued until fbevents.js loads) + the same event_id relayed server-side.
    track('PageView', {});

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
      track('ViewContent', {
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

    // AddToCart — intercept storefront cart/add (form post and fetch to
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
    var nativeFetch = window.fetch;

    // Purchase is sent by the orders/paid webhook, which has no browser: copy the Meta cookies into
    // hidden cart attributes so they reach the order (note_attributes). The underscore hides them from
    // customers. Two routes: a form post to /cart/add carries them as hidden inputs (the only route for
    // "buy now", which goes straight to checkout), and AJAX adds or carts from an earlier visit get a
    // /cart/update.js. Only a cart that has items is updated. Never touches items; failures are swallowed.
    var ATTR_CHECKED_KEY = '_meta_attrs_checked';
    var addGeneration = 0;
    var syncTimer = null;
    // Cart writes the theme has in flight (seen through the fetch wrapper). Ours waits for them: simultaneous
    // cart requests can answer 409, and product-form.js shows any error on an add to the customer.
    var cartBusy = 0;
    var syncPending = false;
    function sessionStore() {
      try { return window.sessionStorage || null; } catch (e) { return null; }
    }
    // The part after fb.1.<ms>. : a rebuilt fbc gets a new timestamp each time for the same click.
    function clickId(fbc) {
      var parts = String(fbc || '').split('.');
      return parts.length > 3 ? parts.slice(3).join('.') : '';
    }
    function syncCartAttributes(force) {
      try {
        if (!nativeFetch) return;
        var fbp = cookie('_fbp');
        var fbc = currentFbc();
        if (!fbp && !fbc) return;
        var sig = (fbp || '') + '|' + clickId(fbc);
        var store = sessionStore();
        try { if (!force && store && store.getItem(ATTR_CHECKED_KEY) === sig) return; } catch (e) {}
        var generation = addGeneration;
        // Only remember a check whose outcome is settled, and not if an add started meanwhile.
        var markChecked = function () {
          try { if (store && generation === addGeneration) store.setItem(ATTR_CHECKED_KEY, sig); } catch (e) {}
        };
        nativeFetch.call(window, '/cart.js', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (cart) {
            if (!cart) return;
            if (!cart.item_count) { if (!force && cartBusy === 0) markChecked(); return; }
            var current = cart.attributes || {};
            var sameClick = !fbc || clickId(current._fbc) === clickId(fbc);
            if ((!fbp || current._fbp === fbp) && sameClick) { markChecked(); return; }
            if (cartBusy > 0) { syncPending = true; return; }
            // Both values every time: whether a partial update merges or replaces is not documented.
            var attrs = {};
            var sendFbp = fbp || current._fbp;
            var sendFbc = sameClick ? current._fbc : fbc;
            if (sendFbp) attrs._fbp = sendFbp;
            if (sendFbc) attrs._fbc = sendFbc;
            return nativeFetch.call(window, '/cart/update.js', {
              method: 'POST',
              credentials: 'same-origin',
              keepalive: true,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ attributes: attrs })
            }).then(function (r) { if (r && r.ok) markChecked(); });
          })
          .catch(function () {});
      } catch (e) {}
    }
    function scheduleSync(delay) {
      try {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(function () {
          syncTimer = null;
          if (cartBusy > 0) { syncPending = true; return; }
          syncCartAttributes(true);
        }, delay);
      } catch (e) {}
    }
    // Forget the session check so the next page looks at the cart again if the add leaves the page or
    // has not landed by the time we look. The timer covers a form the theme takes over by other means than fetch.
    function syncAfterAdd() {
      addGeneration++;
      try { var store = sessionStore(); if (store) store.removeItem(ATTR_CHECKED_KEY); } catch (e) {}
      scheduleSync(2000);
    }
    function setHiddenInput(form, name, value) {
      if (!value) return;
      var field = form.querySelector('input[name="' + name + '"]');
      if (!field) {
        field = document.createElement('input');
        field.type = 'hidden';
        field.name = name;
        form.appendChild(field);
      }
      field.value = value;
    }
    // Runs in the capture phase, before the browser or the theme reads the form.
    function addAttributesToForm(form) {
      try {
        setHiddenInput(form, 'attributes[_fbp]', cookie('_fbp'));
        setHiddenInput(form, 'attributes[_fbc]', currentFbc());
      } catch (e) {}
    }

    function fireAddToCart(variantId, navigating) {
      var now = Date.now();
      if (now - lastAtcTs < 1000) return;
      lastAtcTs = now;
      syncAfterAdd();
      var v = variantId ? variantsById[String(variantId)] : null;
      var payload = { content_type: 'product', currency: currency };
      if (v && v.sku) {
        payload.content_ids = [String(v.sku)];
        var val = toMoney(v.price);
        if (val !== undefined) payload.value = val;
        track('AddToCart', payload);
        return;
      }
      // Variant not on this page (collection quick-add, upsell rail, cart drawer):
      // read the SKU back from /cart.js once the add has landed. Items are listed
      // most recent first, so with no variant id the first item is the one added.
      // A plain form post leaves the page: no time to wait for /cart.js.
      if (!nativeFetch || navigating) { track('AddToCart', payload); return; }
      setTimeout(function () {
        nativeFetch.call(window, '/cart.js', { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (cart) {
            var items = (cart && cart.items) || [];
            var item = null;
            for (var i = 0; i < items.length; i++) {
              if (!variantId || String(items[i].variant_id) === String(variantId)) { item = items[i]; break; }
            }
            if (item && item.sku) {
              payload.content_ids = [String(item.sku)];
              if (typeof item.final_price === 'number') payload.value = item.final_price / 100;
              if (cart.currency) payload.currency = cart.currency;
            }
            track('AddToCart', payload);
          })
          .catch(function () { track('AddToCart', payload); });
      }, 1200);
    }

    document.addEventListener('submit', function (ev) {
      try {
        var form = ev.target;
        if (form && form.action && /\\/cart\\/add/.test(form.action)) {
          addAttributesToForm(form);
          var idField = form.querySelector('[name="id"]');
          var vid = idField && idField.value;
          // Capture phase runs before the theme's handler: wait one tick to see whether
          // it took over with AJAX (defaultPrevented; its fetch has then fired already)
          // or lets the browser post the form and navigate away.
          setTimeout(function () { fireAddToCart(vid, !ev.defaultPrevented); }, 0);
        }
      } catch (e) {}
    }, true);

    if (window.fetch) {
      var _fetch = window.fetch;
      window.fetch = function () {
        var isAdd = false;
        var isCartWrite = false;
        try {
          var url = arguments[0];
          var href = typeof url === 'string' ? url : (url && url.url) || '';
          isCartWrite = /\\/cart\\/(add|change|update)/.test(href);
          if (/\\/cart\\/add(\\.js)?/.test(href)) {
            isAdd = true;
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
        var result = _fetch.apply(this, arguments);
        // Sync once the theme's cart writes have all landed, rather than racing them. A separate chain: the
        // caller's promise is untouched.
        if (isCartWrite && result && result.then) {
          cartBusy++;
          var settled = function () {
            cartBusy--;
            if (cartBusy === 0 && syncPending) { syncPending = false; scheduleSync(300); }
          };
          result.then(function () { if (isAdd) syncPending = true; settled(); }, settled);
        }
        return result;
      };
    }

    // A returning visitor can go straight to checkout with a cart from an earlier visit. Waits for
    // fbevents.js to have set the cookies (it now loads lazily: wait for its load event, 8 s at most).
    var cartSyncDone = false;
    function initialCartSync() { if (cartSyncDone) return; cartSyncDone = true; syncCartAttributes(false); }
    if (!window.__lcFbLazy) setTimeout(initialCartSync, 1500); // fbq was already on the page: SDK not ours to time
    else if (window.__lcFbReady) setTimeout(initialCartSync, 300);
    else {
      try { document.addEventListener('lc:fb-ready', function () { setTimeout(initialCartSync, 300); }); } catch (e) {}
      setTimeout(initialCartSync, 8000);
    }
  } catch (e) { /* never break the storefront */ }
})();
`;
}

export async function GET(request: Request) {
  const pixelId = env.metaPixelId;
  // The relay URL is derived from this script's own origin (not user input beyond the Host header,
  // restricted to a hostname charset) so it works on any deployment alias.
  const host = new URL(request.url).host;
  const capiUrl = /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `https://${host}/api/capi/event` : "https://aosom-sync.vercel.app/api/capi/event";
  // Only digits are valid Meta Pixel IDs; reject anything else to keep the
  // interpolation injection-proof even though the value is operator-controlled.
  const body = pixelId && /^[0-9]+$/.test(pixelId) ? buildPixelScript(pixelId, capiUrl) : EMPTY_SCRIPT;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // Short cache so toggling the env var propagates within minutes.
      "Cache-Control": "public, max-age=300",
    },
  });
}
