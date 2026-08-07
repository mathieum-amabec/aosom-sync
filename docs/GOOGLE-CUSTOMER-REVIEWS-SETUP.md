# Google Customer Reviews — setup runbook

**Store:** 27u5y2-kp.myshopify.com (Basic plan, CA) · **Merchant Center ID:** `5804673777`
**Status:** to be completed in the Shopify + Google admin UIs (no code in this repo).

## Why there is no code / theme change

The order-confirmation ("thank you" / order-status) page is owned by **Shopify Checkout**,
not the theme. On this store the theme-injection route is a dead end:

- Theme `160059195497` is Online Store 2.0 — no `checkout.liquid` (Plus-only), no
  `order-status` section. Injecting into `layout/theme.liquid` would fire on every page and
  render the `{{ order.* }}` / `{{ customer.email }}` Liquid vars **empty** (they only exist
  in checkout), so Google Customer Reviews would get no order_id/email and fail.
- The legacy injection points — order-status **Additional Scripts** and **ScriptTags**
  (`display_scope=order_status`) — were **disabled by Shopify on 2025-08-28** (forced
  checkout-extensibility migration). They no longer run on the confirmation page.

The raw GMC opt-in snippet (`gapi.surveyoptin.render({merchant_id: 5804673777, ...})`) only
ever worked inside the now-removed Additional Scripts box. The supported replacement is the
Google channel app + Merchant Center, below.

### "Just use Settings → Checkout → Order status page additional scripts"

That box no longer exists. It is not the modern Checkout-Extensibility route — it is the
thing Checkout Extensibility **removed**. From Shopify's own developer changelog:

> Checkout Extensibility replaces checkout.liquid, apps with script tags and **additional
> scripts** on the Thank you and Order status pages. […] **August 28, 2025 — the removal
> date of checkout.liquid, apps with script tags and additional scripts on the thank you and
> order status page.**
> — [UI extensions on the Thank you and Order status pages have launched](https://shopify.dev/changelog/ui-extensions-on-the-thank-you-and-order-status-pages-have-launched)

And specifically for Basic / Shopify / Advanced plans (this store is **Basic**):

> Additional scripts and apps with script tags on the Thank you and Order status pages **will
> be turned off** […] These must be replaced with a compatible app from the Shopify App Store
> or rebuilt with **UI extensions and web pixels**.
> — [New checkout functionality for merchants on Basic, Shopify, and Advanced plans](https://shopify.dev/changelog/new-checkout-functionality-for-merchants-on-basic-shopify-and-advanced-plans)

Re-verified against the live store on 2026-08-06:

| Check | Result |
| --- | --- |
| `shop.plan_name` | `basic` (so `checkout.liquid` is not available at all — Plus-only) |
| `layout/checkout.liquid` on the live theme | **absent** |
| any `order-status` template/section | **absent** |
| ScriptTags with `display_scope=order_status` | **0** (only 2 `online_store` pixel tags) |

**Nor can a Web Pixel carry it.** Custom pixels run in Shopify's sandboxed iframe with no
top-frame DOM (the same constraint documented for the Meta Purchase pixel in `CLAUDE.md`).
GCR's opt-in is a rendered widget — `gapi.surveyoptin.render()` needs the real page DOM — so
the web-pixel route that replaces additional scripts for *tracking* cannot host it either.

That leaves exactly one supported path: the App Store app, which is the Google & YouTube
channel below.

## Install steps (one-time, ~5 min, requires store-owner login)

1. **Shopify admin → Apps → Shopify App Store** → install **"Google & YouTube"** (publisher:
   Google). This is the official Google sales channel for Shopify.
2. In the app, **connect the Google account** that owns Merchant Center `5804673777` and link
   that Merchant Center account. (Create one only if the link prompts for it — do NOT make a
   second Merchant Center; reuse `5804673777`.)
3. Let the app finish the **product sync** and any Merchant Center account verification /
   claim it requests.
4. **Google Merchant Center → enable Customer Reviews:** in Merchant Center (account
   `5804673777`), open the **Customer Reviews** program and turn it on, accepting the program
   agreement. With the store linked through the Google channel, Google handles the
   order-confirmation survey opt-in for eligible orders server-side — no on-page snippet
   needed.
5. **Verify** after the first real (or test) order: confirm the opt-in survey appears at
   checkout completion and that orders flow into Merchant Center → Customer Reviews. The
   seller-rating badge appears after Google collects enough reviews (Google's threshold,
   typically ~100 in 12 months).

## Notes

- Exact menu labels in Merchant Center / the Google channel app shift over time; follow the
  in-product wording for "Customer Reviews". Authoritative docs:
  Google Merchant Center Help → "Customer reviews", and Shopify Help → "Google & YouTube".
- If a future migration to **Shopify Plus** happens, a Checkout UI Extension becomes an
  option, but the Google-app path above remains the recommended way to collect GCR.
- Logged in `docs/DATA-OPS-LOG.md` (2026-06-09 entry).

---

## Why a Thank-you page UI extension cannot carry GCR either

Checkout Extensibility's replacement for additional scripts is "a compatible app from the
Shopify App Store or **UI extensions and web pixels**". A Thank-you page UI extension is
therefore the right *shape* — but it still cannot host Google Customer Reviews, for a
reason that is structural rather than a policy choice:

> Customer account UI extensions run in a **sandboxed Web Worker, not in the browser page
> itself.**
> — [Enable extension capabilities](https://shopify.dev/docs/apps/build/customer-accounts/capabilities)

> The UI components for post-purchase checkout extensions are **managed by Shopify**.
> — [Build a post-purchase product offer](https://shopify.dev/docs/apps/build/checkout/product-offers/build-a-post-purchase-offer)

GCR's opt-in is `gapi.surveyoptin.render()`: it loads Google's own JavaScript and renders a
widget into the page DOM. An extension has neither — no third-party script loading, no DOM,
only Shopify's component set. Extensions can make network calls (with `network_access = true`),
so an extension could POST order data to our backend, but Google exposes no server-side
endpoint that registers an opt-in, so that chain dead-ends.

**Do not scaffold the extension.** It would look like progress and could never work.

## The route that does work: a Merchant Center order feed

GCR has a second integration that needs no page script at all. Merchant Center accepts an
**order feed**; Google emails the survey itself. The required fields are exactly:

| Field | Source |
| --- | --- |
| `order_id` | Shopify order `name` / `id` |
| `email` | Shopify order `email` |
| `country_code` | `shipping_address.country_code` |
| `estimated_delivery_date` | order date + 8 business days |
| `products` (optional) | line-item SKUs, matching the Google feed `g:id` |

This fits the repo's existing shape — it is another route beside `/api/feeds/*`.

### Blocker: the Shopify token lacks `read_orders`

Verified 2026-08-06:

```
GET /admin/api/2025-01/orders.json  ->  403
{"errors":"[API] This action requires merchant approval for read_orders scope."}
```

The token carries 31 scopes (products, themes, inventory, discounts, translations, …) but
**no order scope at all**. Orders are protected customer data, so Shopify requires an
explicit merchant grant.

**To unblock:** Shopify admin → Settings → Apps and sales channels → Develop apps → the
custom app → Configuration → Admin API scopes → tick **`read_orders`** → Save, then
reinstall/refresh the token and update `SHOPIFY_ACCESS_TOKEN`.

### Security requirement before this ships

An order feed carries **customer email addresses**. Unlike the product feeds it must never
be public: `src/lib/proxy.ts` allowlists the whole `/api/feeds` prefix, so this route has to
live outside it (or be explicitly excluded) and be gated by a secret Merchant Center fetches
with — Google supports HTTP basic auth on feed URLs. Shipping it on the public prefix would
publish every customer's email.

That combination — a scope we cannot grant ourselves plus a PII surface that must be gated
correctly on the first try — is why the code is specified here rather than merged blind.
