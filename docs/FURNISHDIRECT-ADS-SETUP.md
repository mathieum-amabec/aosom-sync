# furnishdirect.ca — ads setup (Google + Meta)

Status 2026-10-25: furnishdirect.ca is **live** (EN, root of the domain) and attached to the Canada market next
to ameublodirect.ca (FR). Pixel Meta `214720653324969` and Google tag `AW-18406522701` already fire there
(ScriptTag + custom web pixel run on every store domain). This doc covers what is left before spending on ads.

## 0. What the code now does
- `GET /api/feeds/google-en` — Google Merchant feed in English: `custom.title_en` titles, brand "Furnish Direct",
  links `https://furnishdirect.ca/products/{handle}[?variant=…]`. Same SKUs as the FR feed.
- `GET /api/feeds/pinterest-en` and every EN item from `getFeedItems({ english: true })` now link to
  furnishdirect.ca (they used to link `ameublodirect.ca/en/…`, which now 301-redirects — a redirecting landing
  page is a Merchant Center disapproval).
- FR feed (`/api/feeds/google`) is unchanged and keeps serving ameublodirect.ca.

## 1. Google Merchant Center — recommended: a SECOND account "Furnish Direct"
Why not reuse account `5804673777`: its website claim is ameublodirect.ca, and the EN feed would reuse the same
offer ids (SKUs) as sources `10671130931` (CA/en) and `10705915442` (CA/fr) → collisions / mixed landing domains.
A dedicated account has its own website claim, shipping, returns and diagnostics.

Operator steps (need the Google account that owns the business; no API token with the `content` scope exists):
1. DNS TXT for verification: Shopify Admin → Settings → Domains → furnishdirect.ca → DNS settings → add the TXT
   record Google gives (Search Console → add **Domain property** furnishdirect.ca). DNS is Shopify-managed, so
   this is the route that does not need a theme edit (themes are 20/20).
2. merchants.google.com → create account "Furnish Direct", country Canada, website https://furnishdirect.ca,
   verify + claim with the Search Console property.
3. Shipping: free standard shipping, Canada (same as account 5804673777). Returns: 10 % restocking fee + label
   (see policy), same policy URL on furnishdirect.ca. Add the business address/phone required by Google.
4. Products → Data sources → Add → **Fetch from URL**: `https://aosom-sync.vercel.app/api/feeds/google-en`,
   feed label `CA`, language `English`, country Canada, daily fetch ~01:00 America/Toronto.
5. Wait for ingest, then check Diagnostics: expect ~2 100 offers, 0 disapprovals. Watch "Mismatched domains"
   and "Product page unavailable" (unpublished products are already excluded by the feed).

Alternative (single account): Business info → add furnishdirect.ca as an additional website and use a distinct
feed label (e.g. `CAEN`). Only if the UI offers multi-website; keep SKUs unique per (label, language).

## 2. Google Ads (customer 6289357042, login-customer-id 2953431617)
1. Ads → Tools → Linked accounts → Merchant Center → link the new "Furnish Direct" account (the existing
   link `1815186930` → MC 5804673777 stays). Query links with `product_link`, on the CLIENT account.
2. New Shopping campaign "Furnish Direct — Google Shopping CA (EN)": sales country CA, **feed label CA of the new
   MC account**, Canada **excluding Quebec** (the FR campaign `24177510904` is Quebec-only — never overlap),
   Search partners off, local inventory off, manual CPC or Maximize clicks like the FR one, budget decided by
   Mat (start 20 CAD/day), created **PAUSED**, enable only after MC diagnostics are clean.
   Constraints already learned: no LANGUAGE criterion on Shopping, listing group type is `UNIT` (needs
   `cpc_bid_micros`), no sitelinks. Create via API v23/v24 (v22 is deprecated).
3. Conversions: the account already counts "Google Shopping App Purchase" etc.; the gtag fires on furnishdirect.ca.
   Do one test order on furnishdirect.ca and confirm it appears (Goals → Conversions → status Recording).

## 3. Meta
- Pixel `214720653324969` is shared; events from furnishdirect.ca show with `domain=furnishdirect.ca`.
- Ad account `act_20658834` is personal (no Business Manager) → **domain verification is not possible** until a
  Business portfolio owns the account/pixel/pages. Not blocking for running ads; blocking for AEM priority.
- **The "Furnish Direct" Facebook page (1080288908505354) is not in the ad account's `promote_pages`** (only
  Ameublo Direct is). Fix in Meta: Page settings → Advertising access / add the page to the ad account, then
  verify `GET /act_20658834/promote_pages` lists it. Instagram: the page's IG business account is
  `17841429817576922`; `instagram_accounts` on the ad account is empty — connect it the same way.
- Page website already set to https://furnishdirect.ca (2026-10-25).
- Ads (video/sales, not DPA — see memory): landing URLs `https://furnishdirect.ca/…`, target Canada excluding
  Quebec for the EN set. A DPA EN catalog would need a Meta EN feed (not built; `meta`/`meta-xml` feeds are FR).

## 4. Verify before spending
- `curl -s https://aosom-sync.vercel.app/api/feeds/google-en | head` → links all `https://furnishdirect.ca/products/…`.
- furnishdirect.ca console: no CORS errors (PR "allow furnishdirect.ca on roue + storefront CORS" must be deployed).
- Test purchase on furnishdirect.ca → Meta "Test events" shows Purchase; Google Ads shows the conversion.
