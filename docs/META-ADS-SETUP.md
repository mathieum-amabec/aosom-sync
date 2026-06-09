# Meta Ads — Setup Guide

This connects an existing **Meta ad account** to Aosom Sync so campaigns and
insights can be managed via the app (`src/lib/meta-ads-client.ts` →
`GET /api/ads`). The Meta Ads use cases were enabled on the Facebook app
(developers.facebook.com → *Use cases*), so the only remaining step is wiring up
an access token with Ads permissions.

> ⚠️ **Spend safety.** `createCampaign` always defaults new campaigns to
> `PAUSED` — nothing spends money until it is explicitly activated in Ads
> Manager. The client also enforces a process-local cap of **200 API
> calls/hour** (`META_ADS.RATE_LIMIT_PER_HOUR`) as a guardrail.

## 1. Find your ad account ID

1. Open [Meta Ads Manager](https://adsmanager.facebook.com/).
2. The ad account ID is the number in the URL or the account dropdown, e.g.
   `123456789012345`. The API addresses it as `act_123456789012345`.

## 2. Get an access token with Ads permissions

The token needs the `ads_read` scope (read accounts/campaigns/insights) and
`ads_management` (to create campaigns).

**Option A — Graph API Explorer (quick, ~1h token, good for testing):**

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Select the Aosom-sync app.
3. Add permissions: `ads_read`, `ads_management`, `business_management`.
4. Generate the token and (recommended) extend it to a 60-day token via the
   [Access Token Tool](https://developers.facebook.com/tools/debug/accesstoken/).

**Option B — System User token (recommended for production, long-lived):**

1. [Business Settings](https://business.facebook.com/settings) → **Users → System
   Users** → *Add* (or pick an existing one).
2. Assign the **ad account** to the system user with *Manage campaigns* access.
3. **Generate new token** → select the Aosom-sync app → scopes `ads_read`,
   `ads_management` → set a long expiry (or "never").
4. Copy the token — it is shown only once.

## 3. Configure the environment

Add to `.env.local` (local) and to the Vercel project env (production):

```bash
META_ACCESS_TOKEN=EAAG...your_token...
```

The token is read via `env.metaAccessToken` in `src/lib/config.ts`. If it is
missing, `GET /api/ads` responds `503` with a pointer back to this guide.

## 4. Verify

The endpoint is **session-protected** (`isAuthenticated`) — call it while logged
into the dashboard, or with a valid session cookie.

```bash
# Ad accounts the token can manage
curl -s --cookie "session=<your-cookie>" \
  "https://aosom-sync.vercel.app/api/ads?resource=accounts" | jq

# Active campaigns (first ad account, or pass &adAccountId=act_123...)
curl -s --cookie "session=<your-cookie>" \
  "https://aosom-sync.vercel.app/api/ads?resource=campaigns" | jq

# Current-month metrics (spend, reach, clicks, ROAS)
curl -s --cookie "session=<your-cookie>" \
  "https://aosom-sync.vercel.app/api/ads?resource=insights" | jq
```

## API reference

`src/lib/meta-ads-client.ts` (Marketing API **v18.0** — bump
`META_ADS.API_VERSION` in `config.ts` to migrate):

| Function | Purpose |
|----------|---------|
| `getAdAccounts()` | List ad accounts the token manages |
| `getCampaigns(adAccountId)` | List **active** campaigns |
| `createCampaign(adAccountId, params)` | Create a campaign (defaults to `PAUSED`) |
| `createAdSet(adAccountId, params)` | Create an ad set with targeting + `promoted_object` (defaults to `PAUSED`) |
| `getAdSets(campaignId)` | List ad sets in a campaign |
| `getInsights(adAccountId, dateRange)` | Spend / reach / impressions / clicks / CPC / CPM / CTR / ROAS |

`GET /api/ads` resources: `accounts` (default), `campaigns`, `insights`. The
`campaigns` and `insights` resources accept an optional `&adAccountId=act_…`;
when omitted they use the first manageable ad account. `insights` always reports
the **current calendar month**.

### Creating a campaign (example)

`createCampaign` is exposed in the client but intentionally **not** wired to a
mutating HTTP route yet (the route is read-only). To create from a script:

```ts
import { createCampaign } from "@/lib/meta-ads-client";

await createCampaign("act_123456789012345", {
  name: "Spring Patio — Traffic",
  objective: "OUTCOME_TRAFFIC",
  // status defaults to PAUSED — activate manually in Ads Manager after review
  dailyBudget: 2000, // 20.00 in the account currency's minor unit (cents)
});
```

## Dynamic Ads — catalog retargeting (first campaign)

Goal: retarget 30-day site visitors with products from the Meta catalog
(**966 products**, catalog id `1103064966519153`, Pixel connected). One **PAUSED**
campaign + ad set on ad account `act_20658834`.

**Model:** one `PRODUCT_CATALOG_SALES` campaign → one ad set that targets a custom
audience (site visitors) in Canada and promotes the catalog. Everything is created
**PAUSED**; you review and activate in Ads Manager.

### Scripted creation (dry-run first)

`scripts/create-meta-dynamic-ads.mjs` builds and (optionally) sends the payloads.
It is **dry-run by default — it prints the payloads and sends nothing**:

```bash
# 1. Dry-run — review the exact campaign + ad set payloads (no API call)
node scripts/create-meta-dynamic-ads.mjs

# 2. Create for real (both PAUSED). --audience-id is REQUIRED so the ad set
#    actually retargets instead of spending on cold traffic.
node scripts/create-meta-dynamic-ads.mjs --apply --audience-id <30d-visitors-audience-id>
```

Flags: `--audience-id <id>` (custom audience of site visitors — required for
`--apply`), `--product-set-id <id>` (promote a product *set* instead of the whole
catalog), `--objective <obj>` (default `PRODUCT_CATALOG_SALES`), `--daily-budget
<cents>`.

### Payloads

```jsonc
// POST /act_20658834/campaigns
{ "name": "Ameublo Direct — Retargeting", "objective": "PRODUCT_CATALOG_SALES",
  "status": "PAUSED", "special_ad_categories": ["NONE"] }

// POST /act_20658834/adsets
{ "campaign_id": "<from step 1>", "name": "Retargeting — Visiteurs 30j",
  "targeting": { "geo_locations": { "countries": ["CA"] },
                 "custom_audiences": [{ "id": "<30d-visitors-audience-id>" }] },
  "promoted_object": { "product_catalog_id": "1103064966519153" },
  "billing_event": "IMPRESSIONS", "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
  "optimization_goal": "OFFSITE_CONVERSIONS", "status": "PAUSED" }
```

### Caveats to confirm before `--apply`

- **Objective taxonomy (ODAX).** `PRODUCT_CATALOG_SALES` is the legacy objective.
  On newer accounts Meta may require `OUTCOME_SALES` instead (pass `--objective
  OUTCOME_SALES`). The dry-run lets you confirm which the account accepts.
- **`promoted_object`.** Catalog-sales ad sets usually want a **product set**
  (`product_set_id` + `custom_event_type: PURCHASE`), not the bare catalog id. Use
  `--product-set-id <id>` if Meta rejects `product_catalog_id`. Create a product set
  (or use "All products") in Commerce Manager → Catalog → Product sets.
- **Custom audience.** The 30-day visitors audience must already exist (Pixel-based
  Website Custom Audience). The script refuses `--apply` without `--audience-id` so a
  retargeting ad set can't accidentally run against cold traffic.

> The same payloads are available programmatically via `createCampaign` +
> `createAdSet` in `src/lib/meta-ads-client.ts` (both default to `PAUSED`).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `503 META_ACCESS_TOKEN not configured` | Token not set in env — see step 3 |
| `Meta Ads API: ... (code 190)` | Token expired/invalid — regenerate (step 2) |
| `Meta Ads API: ... (code 200/10)` | Missing `ads_read`/`ads_management` permission |
| `Meta Ads rate limit reached (200/hour)` | Client guardrail tripped — wait, or raise `META_ADS.RATE_LIMIT_PER_HOUR` |
| Empty `accounts` array | Token's user/system-user has no ad account assigned (step 2B.2) |
