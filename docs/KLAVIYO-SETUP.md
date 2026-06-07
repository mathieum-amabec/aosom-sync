# Klaviyo Email Flows — Setup Guide

Email marketing automation for the Ameublo Direct (FR) / Furnish Direct (EN)
Shopify store. Klaviyo is **not** integrated in this codebase — it connects to
Shopify directly via the Klaviyo app, no code changes here. This guide covers
account setup, the Shopify connection, and the four core flows with bilingual
templates.

> Reviews are handled by **Judge.me** (`app.judge.me`), not Klaviyo — the
> post-purchase flow links to the Judge.me review request rather than asking for
> a review inline.

## 1. Create the Klaviyo account

1. Sign up at [klaviyo.com](https://www.klaviyo.com) — the free tier covers up to
   **250 contacts / 500 email sends per month** (enough to validate flows before
   the list grows).
2. Set the **sending domain** to `ameublodirect.ca` and complete DNS
   authentication (Klaviyo provides DKIM/SPF/CNAME records). Unauthenticated
   sends land in spam — do this before sending anything.
3. Set the account **default sender name/address** (e.g. `Ameublo Direct
   <bonjour@ameublodirect.ca>`).

## 2. Connect Shopify → Klaviyo

1. In the Shopify admin, install the **Klaviyo: Email Marketing & SMS** app from
   the Shopify App Store, or in Klaviyo go to **Integrations → Shopify → Connect**.
2. Enable these during setup:
   - **Sync historical data** (customers, orders, products).
   - **Onsite tracking** (the Klaviyo `klaviyo.js` snippet — needed for browse +
     cart events). Klaviyo injects this through the app; no manual theme edit
     required, but confirm it loads on the storefront.
   - **Accepts-marketing sync** so Shopify newsletter consent flows into Klaviyo
     (consent matters for CASL/GDPR — only email contacts who opted in).
3. Confirm Shopify is sending these events to Klaviyo: `Placed Order`,
   `Checkout Started`, `Viewed Product`, `Added to Cart`, `Fulfilled Order`.
   These are the triggers the flows below depend on.

## 3. Bilingual strategy (FR / EN)

The store is bilingual. Two clean options — pick one and apply it to every flow:

- **Option A — one flow, conditional split (recommended).** Build each flow once,
  add a **conditional split** on the contact's language near the top
  (`person.properties.Language` synced from Shopify locale, or
  `Accepts Marketing → Locale`), and branch to FR vs EN email versions. One flow
  to maintain, language picked per contact.
- **Option B — two lists/segments.** Maintain separate FR and EN segments and
  duplicate each flow per language. Simpler templates, double the maintenance.

Default to **Option A**. Set the contact `Language` property from the Shopify
customer locale during the integration sync so the split has data to branch on;
fall back to FR (primary market: Québec) when locale is unknown.

## 4. Flows to create

Create under **Flows → Create flow**. Suggested timing in parentheses.

### a) Welcome series — trigger: newsletter signup / list subscription
- **Email 1 (immediately):** welcome + brand intro + the signup incentive
  (e.g. free shipping or % off first order, if offered).
- **Email 2 (+2 days):** best-sellers / category highlights (Mobilier, Jardin,
  Animaux), link to the storefront.
- **Email 3 (+4 days):** social proof + the incentive reminder with an expiry.
- Exit the flow on `Placed Order`.

### b) Abandoned cart — trigger: `Checkout Started`, not `Placed Order`
- **Email 1 (+1 hour):** "You left something behind" + dynamic cart contents
  (product image, name, price) via the event's line items.
- **Email 2 (+24 hours):** reminder + light urgency (low stock / popular item),
  optional small incentive.
- Exit on `Placed Order`. Add a filter to skip customers who ordered in the last
  N days if desired.

### c) Post-purchase — trigger: `Placed Order` (or `Fulfilled Order` for the review ask)
- **Email 1 (immediately, on Placed Order):** thank-you + order summary + what to
  expect on shipping/delivery (dropship lead times).
- **Email 2 (+10–14 days, on Fulfilled Order):** **review request → Judge.me.**
  Link to the Judge.me review form for the purchased product
  (`https://judge.me/reviews/ameublodirect.myshopify.com` or the product-specific
  Judge.me link). Keep the ask honest — the store is still accruing reviews.
- Optional Email 3: cross-sell complementary categories.

### d) Browse abandonment — trigger: `Viewed Product`, no `Added to Cart` / `Placed Order` after
- **Email 1 (+4–6 hours):** "Still thinking it over?" + the viewed product
  (dynamic image/name/price) + a link back to the product page.
- Filter: only contacts who have opted into marketing (browse abandonment to
  non-consented contacts is a compliance risk). Exit on `Added to Cart` or
  `Placed Order`.

## 5. Templates — bilingual checklist

For each flow email, build FR and EN versions (per the Option A split):
- **Subject + preview text** localized (not machine-translated as an
  afterthought — Québec French, tutoiement, matching the social voice).
- **Brand:** FR emails use **Ameublo Direct**, EN emails use **Furnish Direct**
  (logo + sender name + footer).
- **Currency:** CAD in both.
- **Dynamic blocks** (cart/product) pull from the trigger event — verify they
  render with a real test profile before going live.
- **Footer:** physical address + one-click unsubscribe (legally required for
  CASL/CAN-SPAM). Klaviyo adds these automatically — don't remove them.

## 6. Before turning flows live

- Send a **test email** for every flow email (FR and EN) to a seed address;
  confirm dynamic content, links (especially the Judge.me link), and rendering on
  mobile.
- Set flows to **Live** (not Manual/Draft) only after the test passes.
- Confirm **smart sending** and **quiet hours** are on to avoid over-emailing.
- Watch the first week: deliverability, open/click rates, and unsubscribe rate.

## Notes
- No code in this repo touches Klaviyo — it is a Shopify-app + Klaviyo-dashboard
  setup. If we later want server-side events (e.g. custom catalog events), that
  would be a separate integration via the Klaviyo API.
- Consent first: only email contacts who opted into marketing. Browse/cart flows
  to non-consented contacts create legal risk under CASL (Canada) and GDPR.
