# Google Ads API — credential provisioning + campaign creation

How to get the Google Ads API working for Ameublo Direct (`ameublodirect.ca`). Most of the
work is **account / credential provisioning**, not code — the code already exists.

> **Status (2026-08-15):** the integration code is in the repo and its dry-run is verified
> end to end. **No credentials exist yet** — `.env.local` contains zero `GOOGLE_ADS_*` vars,
> so nothing can be created against a live account. Steps 1–5 below are what unblocks it.

## Already in place

| Thing | Where |
|---|---|
| Merchant Center account `5804673777` | linked feed sources, see `docs/FEEDS-SETUP.md` |
| Google Shopping product feed | `https://aosom-sync.vercel.app/api/feeds/google` — RSS 2.0 + `g:` namespace, built by `src/lib/feeds/feed.ts`. 2158 items, `g:brand` = "Ameublo Direct", `g:mpn` = Aosom SKU, `identifier_exists=true` |
| API client | `src/lib/google-ads-client.ts` — raw REST, no SDK dependency |
| Campaign builder | `scripts/create-google-shopping-campaign.mts` — dry-run by default |

---

## 1. Google Ads account → the Customer ID

- Sign in at <https://ads.google.com> with the Ameublo Direct Google account. If no account
  exists, create one and **switch to Expert mode** so you land on a standard account rather
  than a Smart-campaign-only one (Smart accounts cannot be driven by the API).
- **Where to find the Customer ID:** it's shown in the **top-right corner of every page** in
  the Google Ads UI, formatted `123-456-7890`. It's also at **Admin → Account settings**, and
  in the account-picker dropdown next to the account name.
- **Strip the dashes** for the env var: `GOOGLE_ADS_CUSTOMER_ID=1234567890`.
  (`normalizeCustomerId()` in the client strips them anyway, but store it clean.)
- If the account is managed under a **Manager (MCC)** account, also capture the manager's ID →
  `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (digits only). It's sent as the `login-customer-id` header.
  Leave it empty when there is no MCC.

## 2. Developer token  ⏳ longest pole — start this first

The developer token is a Google-Ads-specific header sent **in addition to** the OAuth token.
Every other Google API needs only OAuth; this one needs both.

- **Where:** <https://ads.google.com> → **Tools & Settings** (the wrench icon) → **Setup** →
  **API Center**. Direct link: <https://ads.google.com/aw/apicenter>
- ⚠ **API Center only appears on a MANAGER (MCC) account.** If the ad account isn't under one,
  create a free manager account at <https://ads.google.com/home/tools/manager-accounts/> and
  link the ad account to it — otherwise the menu item simply isn't there.
- Fill in the API access application (company name, site, intended use).
- **Access levels** (<https://developers.google.com/google-ads/api/docs/access-levels>):

  | Level | How long | What it can do |
  |---|---|---|
  | **Test** | instant | Only **test** accounts. Every call against the real account fails. |
  | **Basic** | **manual review, typically 1–3 business days** | The real account. 15 000 ops/day. |
  | Standard | further review | Higher quotas — not needed here. |

- Record it → `GOOGLE_ADS_DEVELOPER_TOKEN`. **This step gates every live API call** — apply
  before doing anything else; steps 1, 3, 4, 5 can run in parallel while it's under review.

## 3. OAuth scopes  ← the part that trips people up

Google Ads accepts exactly **one** scope:

```
https://www.googleapis.com/auth/adwords
```

⚠ **This is NOT the Merchant Center scope.** GMC uses
`https://www.googleapis.com/auth/content`. They are different scopes on different APIs:

| | Merchant Center | Google Ads |
|---|---|---|
| Scope | `.../auth/content` | `.../auth/adwords` |
| Extra header | — | `developer-token` (required) |
| Account header | `merchantId` in the path | `login-customer-id` (MCC only) |

**A refresh token is bound to the scope set it was consented with.** A Merchant Center refresh
token therefore **cannot** be reused for Google Ads: it will refresh into a valid access token
and then fail every Ads call with `PERMISSION_DENIED` / insufficient scope. Two valid options:

1. Mint a **dedicated** Ads refresh token with just the `adwords` scope (simplest), or
2. Mint **one** token consented to both scopes at once, and share it across integrations.

`readGoogleAdsCredentials()` accepts the generic `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`GOOGLE_REFRESH_TOKEN` names as a fallback so option 2 works — but only if that token actually
carries the `adwords` scope.

Reference: <https://developers.google.com/google-ads/api/docs/oauth/overview>

## 4. OAuth client (Google Cloud console)

- <https://console.cloud.google.com> → create or select a project (e.g. `ameublo-ads`).
- **Enable the API:** <https://console.cloud.google.com/apis/library/googleads.googleapis.com>
- **Consent screen:** <https://console.cloud.google.com/apis/credentials/consent> — External.
  **Add the Ameublo Google account as a Test user.** An unverified app in "Testing" issues
  refresh tokens that expire in 7 days *unless* the consenting account is a listed test user.
- **Credentials → Create credentials → OAuth client ID → Desktop app:**
  <https://console.cloud.google.com/apis/credentials>
- Record → `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`.

## 5. Refresh token (one-time)

Easiest path with no code — the **OAuth 2.0 Playground**:

1. Open <https://developers.google.com/oauthplayground>
2. Gear icon (top right) → tick **"Use your own OAuth credentials"** → paste the client ID +
   secret from step 4.
3. The OAuth client must allow `https://developers.google.com/oauthplayground` as an
   authorized redirect URI — add it in the Cloud console if it isn't there.
4. Left panel → **"Input your own scopes"** → enter `https://www.googleapis.com/auth/adwords`
   → **Authorize APIs** → sign in as the Ameublo account → allow.
5. **Exchange authorization code for tokens** → copy the **refresh token**.

Record → `GOOGLE_ADS_REFRESH_TOKEN`.

## 6. Add the env vars

Add to `.env.local` **and** Vercel → Project → Settings → Environment Variables
(Production + Preview). Descriptions live in `.env.example`.

```
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
GOOGLE_ADS_REFRESH_TOKEN=...
GOOGLE_ADS_CUSTOMER_ID=...            # digits only, no dashes
GOOGLE_ADS_LOGIN_CUSTOMER_ID=...      # manager (MCC) id, digits only — omit if no MCC
GOOGLE_MERCHANT_CENTER_ID=5804673777
```

Never commit these — `.env.local` is gitignored.

## 7. Link Merchant Center `5804673777` to the Google Ads account

Required for Shopping and retail PMax — the campaign pulls products from the linked MC account.

- **Merchant Center** (`5804673777`) → **Settings → Linked accounts → Google Ads** → send a
  link request to the Customer ID from step 1.
- **Google Ads** → **Tools → Setup → Linked accounts → Google Merchant Center** → approve.
- Confirm the feed is **approved** (Merchant Center → Products → Diagnostics, no blocking
  errors) and set to fetch on a **daily** schedule.

## 8. Conversion tracking — required before value bidding

`MAXIMIZE_CONVERSION_VALUE` bids from modelled conversion **value**. With no conversion action
it bids blind, so `create-google-shopping-campaign.mts --apply` **refuses to run** without an
enabled `PURCHASE` conversion action (`preflight()`).

- Google Ads → **Goals → Conversions → New conversion action → Website → Purchase**, with
  **"Use different values for each conversion"**.
- Install the Google tag + `purchase` event on Shopify via **Settings → Customer events →
  Add custom pixel**, sending `value`, `currency: "CAD"` and `transaction_id`. (Same mechanism
  as the Meta Purchase pixel — see `docs/meta-custom-web-pixel.js` and the CLAUDE.md Meta Pixel
  section. ScriptTags do **not** run on the Checkout-Extensibility thank-you page.)
- Alternatively the official **Google & YouTube** Shopify app auto-wires both the conversion
  and the Merchant Center feed.
- Verify with **Google Tag Assistant** that `purchase` fires on the thank-you page.

---

## Using the integration

### Client — `src/lib/google-ads-client.ts`

Raw REST against `googleads.googleapis.com` (no `google-ads-api` npm dependency, matching the
Meta-ads scripts' plain-`fetch` posture). Handles the OAuth refresh, the `developer-token` and
`login-customer-id` headers, retry on 429/5xx, and flattens Google's nested error envelope into
a readable `GoogleAdsApiError`.

Methods: `createCampaignBudget`, `createCampaign`, `setCampaignBidding`, `createAdGroup`,
`createShoppingAd`, `addNegativeKeywords`, `addLocationTargets`, `addLanguageTargets`,
`addAdSchedule`, `createSitelinks`, `listConversionActions`, `search`.

**Dry-run mode.** Constructed with `dryRun: true` the client sends nothing, records every
payload in `client.plan`, and returns synthetic resource names — so callers build the whole
object chain through one code path with or without credentials. This is why the campaign script
renders a complete campaign against an empty `.env.local`.

**API version.** Pinned at `GOOGLE_ADS_API_VERSION` in the client. Google sunsets a version
roughly every 4 months — check <https://developers.google.com/google-ads/api/docs/release-notes>
before a live run, and override per-run with `--api-version`.

### Campaign script — `scripts/create-google-shopping-campaign.mts`

```powershell
# dry-run (no credentials needed)
node --env-file=.env.local node_modules/tsx/dist/cli.mjs `
  scripts/create-google-shopping-campaign.mts

# create (needs credentials; everything is created PAUSED)
node --env-file=.env.local node_modules/tsx/dist/cli.mjs `
  scripts/create-google-shopping-campaign.mts --apply
```

Run under the **x64 node** (see CLAUDE.md "Windows ARM64").

Builds: $15 CAD/day budget → Shopping campaign (MC `5804673777`, feed label `CA`, priority
MEDIUM, `MAXIMIZE_CONVERSION_VALUE`) → Canada + FR/EN targeting → 24/7 ad schedule → 10 negative
keywords → ad group "Tous les produits" ($1.50 max CPC) → Shopping ad + all-products listing
group → 8 sitelinks (4 FR + 4 EN).

Flags: `--apply`, `--daily-budget`, `--max-cpc`, `--bidding`, `--target-roas`,
`--safe-free-negatives`, `--skip-sitelinks`, `--api-version`.

> **`.mts` scripts import `src/lib` DYNAMICALLY.** tsx transpiles `src/**/*.ts` to CJS and
> node's ESM loader can't see named exports across that boundary, so a static
> `import { X } from "@/lib/…"` in a `.mts` dies at load with *"does not provide an export
> named X"*. Use `await import()` for values and `import type` for types (same convention as
> `scripts/generate-slideshow-batch.mts`). `scripts/lifestyle-image-dry-run.mts` still has the
> static-import form and is broken by it.

### Three things the platform does not allow

These are structural limits, not configuration gaps — the dry-run prints them every run.

1. **Bid modifiers don't work under smart bidding.** `MAXIMIZE_CONVERSION_VALUE` /
   `MAXIMIZE_CLICKS` let Google set every bid, so ad-schedule, device and audience modifiers are
   ignored, as is the ad group's max CPC. The "+20% evenings and weekends" only applies under
   `--bidding manual-cpc`; the client deliberately omits the modifier otherwise rather than
   write a boost into the account that never fires.
2. **Sitelinks don't render on Shopping ads.** They serve on Search. A Shopping product ad is
   the product card (image / title / price / merchant). Shopping promotional pricing comes from
   the **Merchant Center promotions feed** (Merchant Center → Marketing → Promotions), not from
   a Google Ads promotion asset.
3. **Dynamic remarketing is not a Shopping feature, and Meta/Pinterest pixels cannot feed
   Google audiences.** A Standard Shopping campaign can only attach user lists in *observation*
   mode (and the resulting modifiers are ignored under smart bidding). Real dynamic remarketing
   needs a separate **Display / Demand Gen / PMax** campaign, and Google audiences can only be
   built from Google-owned signals: the Google tag, GA4, or **Customer Match** (hashed customer
   emails — available from Shopify). There is no cross-platform pixel import, in either
   direction.

### Recommended launch sequence

The account has no conversion history (~10 real Shopify sales total, and the Meta pixel was
broken before July 2026). Value bidding with zero data bids blind and tends to overspend on
cheap, low-intent traffic.

1. Finish step 8 (Google tag + Purchase conversion with real order value).
2. Launch on `--bidding maximize-clicks` — the $1.50 CPC ceiling **is** honoured there — for
   2–4 weeks to accumulate conversions.
3. Flip to value bidding in place with `setCampaignBidding()`; no rebuild needed (unlike Meta,
   where the optimization event is immutable once an ad set is published).
4. Add `--target-roas` only once there's a stable ROAS to target.

## Next: Performance Max

Once credentials exist and the feed is linked and approved, PMax is the same client plus an
asset-group chain: campaign (`advertisingChannelType: "PERFORMANCE_MAX"`) → asset groups
(reuse the demand-gen images/videos already on YouTube and Blob) → listing group filters →
conversion goals. Create everything PAUSED, mirroring the Meta scripts' safety posture.
