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
