# Google Ads + Performance Max — Setup Checklist

Setup steps to enable **Performance Max (PMax)** retail campaigns for Ameublo Direct
(`ameublodirect.ca`) via the Google Ads API. Most of the work here is **account / credential
provisioning** — not code. Do these in order; several steps gate the next.

> **Status:** greenfield. There is **no Google Ads code** in the repo yet and **no Google Ads
> credentials** in `.env.local`. The product feed already exists (see "Already in place" below).

## Already in place (no action needed)

- **Google Merchant product feed:** `https://aosom-sync.vercel.app/api/feeds/google`
  (RSS 2.0 + `g:` namespace, built by `src/lib/feeds/feed.ts` → `buildGoogleFeed`). Public,
  CDN-cached 10 min. Emits `g:mpn` = Aosom SKU + `identifier_exists=true` (the catalog has no
  GTINs; `brand + MPN` is the identifier pair).
- **Merchant Center ID:** `5804673777` (to be linked in step 3).

---

## 1. Create / confirm the Google Ads account

- Sign in at <https://ads.google.com> with the Ameublo Direct Google account.
- If no account exists, create one. **Skip the guided "Smart campaign" creation** (switch to
  Expert mode) so you land on a standard account, not a Smart-only one.
- Capture the **Customer ID** (format `123-456-7890`) — you'll strip the dashes for the API
  (`GOOGLE_ADS_CUSTOMER_ID=1234567890`).
- If you manage it under a **Manager (MCC)** account, also capture the manager's customer id →
  `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (digits only). Leave unset if there's no MCC.

## 2. Apply for a Developer Token  ⏳ longest pole — start first

- In Google Ads: **Tools → Setup → API Center** (visible on the **manager** account; if the
  account isn't under an MCC, create a free MCC and link the account to get API Center).
- Apply for a **Developer Token**. Approval levels:
  - **Test** access is granted instantly but only works against *test* accounts.
  - **Basic** access (needed to call the real account) requires a short application form and
    **manual review — typically 1–3 business days**. Apply ASAP; it blocks every live API call.
- Record the token → `GOOGLE_ADS_DEVELOPER_TOKEN`.

## 3. Link Google Merchant Center `5804673777` to the Google Ads account

- Required for **retail** PMax (PMax pulls products from the linked Merchant Center).
- In **Merchant Center** (`5804673777`): **Settings → Linked accounts → Google Ads →** send a
  link request to the Customer ID from step 1.
- In **Google Ads**: **Tools → Setup → Linked accounts → Google Merchant Center →** approve.
- Verify the feed is **approved** in Merchant Center (Products → Diagnostics show no blocking
  errors). The feed source is the URL above; set it to **fetch on a daily schedule**.

## 4. Create OAuth credentials (GCP)

- Go to <https://console.cloud.google.com> → create/select a project (e.g. `ameublo-ads`).
- **APIs & Services → Library →** enable the **Google Ads API**.
- **APIs & Services → OAuth consent screen →** configure (External, add the Ameublo Google
  account as a **Test user** so the refresh token doesn't expire on an unverified app).
- **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app.**
- Record → `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`.

## 5. Obtain a Refresh Token (one-time OAuth flow)

- Run an OAuth 2.0 desktop flow with scope **`https://www.googleapis.com/auth/adwords`** to mint
  a long-lived refresh token. Options:
  - Google's helper: `google-ads-api` / `google-ads-python`'s `authenticate_in_desktop_application`,
    or the OAuth Playground (set your own client id/secret, scope `adwords`).
  - Or a small Node script (to be added under `scripts/` when we build the integration) that
    prints the auth URL, takes the pasted code, and exchanges it for the refresh token.
- Record → `GOOGLE_ADS_REFRESH_TOKEN`. **Refresh tokens are long-lived** but revoke if the
  consent screen stays in "Testing" beyond Google's window — keep the account as a Test user.

## 6. Add the env vars (Vercel + `.env.local`)

Add to **Vercel → Project → Settings → Environment Variables** (Production + Preview) **and** to
local `.env.local` (run network scripts with the x64 node — see CLAUDE.md "Windows ARM64"):

```
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
GOOGLE_ADS_REFRESH_TOKEN=...
GOOGLE_ADS_CUSTOMER_ID=...            # digits only, no dashes
GOOGLE_ADS_LOGIN_CUSTOMER_ID=...      # manager (MCC) id, digits only — omit if no MCC
GOOGLE_MERCHANT_CENTER_ID=5804673777
```

> Never commit these. `.env.local` is gitignored. Mirror the Meta-ads convention
> (`META_ACCESS_TOKEN`, etc.) for naming/usage.

## 7. Install conversion tracking (Google Tag on Shopify)

- PMax **requires conversion tracking** to optimize — without a Purchase conversion it can't bid.
- In Google Ads: **Goals → Conversions → New conversion action → Website → Purchase.**
- Install the **Google tag (gtag.js)** + the purchase event on Shopify:
  - Shopify **Settings → Customer events** (Custom pixel) for the gtag + `purchase` event with
    value + currency (CAD) + `transaction_id`, **or** the Google & YouTube Shopify app
    (auto-wires conversion + the Merchant Center feed).
- Verify with **Google Tag Assistant** that the purchase conversion fires on the thank-you page.

---

## After this checklist — what the code work looks like

Once the credentials exist and the feed is approved + linked, building a PMax campaign via the
Google Ads API is the object chain:

1. **Campaign Budget**
2. **Campaign** (`advertising_channel_type = PERFORMANCE_MAX`)
3. **Asset Groups** (reuse demand-gen assets: images, the videos already on YouTube/Blob,
   headlines, descriptions)
4. **Listing Group Filters** (retail — which catalog products PMax may show)
5. **Conversion Goals** (the Purchase action from step 7)

All created **PAUSED** for review before any spend — mirror the Meta-ads scripts' safety posture
(`scripts/meta-ads-dpa-create.mjs`: dry-run default, `--apply`, everything paused).

## Sequencing note

Step **2 (developer token approval)** has 1–3 day latency and gates all API calls — kick it off
first. Steps 3, 4, 5, 7 can proceed in parallel while it's under review.
