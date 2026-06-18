# Meta token rotation — `META_ACCESS_TOKEN`

> ⏰ **Rotate before 2026-08-06.** The token currently in use is a short-lived
> **USER** token (issued 2026-06-07). User tokens last ~60 days, so it likely
> dies around **2026-08-06**; the hard data-access cutoff confirmed via the API is
> **2026-09-07** (after that, even a "valid" token stops returning data). Replace it
> with a **System User token** (no expiry) well before the August date.

`META_ACCESS_TOKEN` powers the Meta Marketing API client (`src/lib/meta-ads-client.ts`,
`GET /api/ads`) and the `scripts/meta-ads-*.mjs` tools. When it expires, those return
Graph error **code 190** and `/api/ads` responds `503`. See also `docs/META-ADS-SETUP.md`.

## Why a System User token

A token from the Graph API Explorer is short-lived (~1h, extendable to ~60 days).
A **System User** token belongs to the Business (not a person), can be set to **never
expire**, and survives password changes — the right choice for production.

## 1. Create the System User token

1. [Business Settings](https://business.facebook.com/settings) → **Users → System Users**.
2. *Add* a system user (or pick an existing one). Give it **Admin** access if it will
   manage campaigns.
3. **Assign assets** to the system user:
   - the **ad account** `act_20658834` → *Manage campaigns* access,
   - the **app** `Aosom-sync` (`2027065584856990`),
   - the **catalog**(s) used for ads, with *Manage catalog* access.
4. Click **Generate new token** → select the **Aosom-sync** app.
5. **Token expiration: `Never`** (System User tokens support this).
6. Select the required scopes (next section) → **Generate token**.
7. **Copy the token now — Meta shows it only once.**

## 2. Required scopes

Select **all** of:

- `ads_read`
- `ads_management`
- `business_management`
- `catalog_management`

(The current token also carries `pages_*` / `instagram_*` scopes for other features;
those live on the separate `FACEBOOK_*` page tokens, so they are **not** required for
`META_ACCESS_TOKEN`. Add them only if you intend to consolidate.)

## 3. Update the token everywhere

The token must be updated in **three** places — local and both Vercel environments:

1. **`.env.local`** (local dev):
   ```bash
   META_ACCESS_TOKEN=EAAG...new_token...
   ```
2. **Vercel → Production**:
   ```bash
   vercel env rm META_ACCESS_TOKEN production
   vercel env add META_ACCESS_TOKEN production   # paste the new token when prompted
   ```
3. **Vercel → Preview**:
   ```bash
   vercel env rm META_ACCESS_TOKEN preview
   vercel env add META_ACCESS_TOKEN preview
   ```
   (Or edit both in the Vercel dashboard → Project → Settings → Environment Variables.)

> ⚠️ Vercel env changes only take effect on the **next deployment**. Redeploy
> Production (and any active Preview) after updating, or trigger a new build.

## 4. Verify the new token

Confirm it is a non-expiring System User token with the right scopes. Uses
`FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET` from `.env.local` to build an app token
(read-only call):

```bash
# from the repo root, with the NEW token already in .env.local
node -e '
const fs=require("fs");
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split(/\r?\n/)
  .map(l=>l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
  .map(m=>[m[1], m[2].replace(/^["\x27]|["\x27]$/g,"")]));
const {META_ACCESS_TOKEN:t, FACEBOOK_APP_ID:a, FACEBOOK_APP_SECRET:s}=env;
fetch(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(t)}&access_token=${a}|${s}`)
  .then(r=>r.json()).then(j=>{
    const d=j.data||{}; const f=x=>x?(x===0?"never (0)":new Date(x*1000).toISOString()):"(absent)";
    console.log("type      :", d.type, "(want SYSTEM_USER)");
    console.log("is_valid  :", d.is_valid);
    console.log("expires_at:", f(d.expires_at), "(want never / 0)");
    console.log("data_exp  :", f(d.data_access_expires_at));
    console.log("scopes    :", (d.scopes||[]).join(", "));
  });
'
```

**Expected after rotation:** `type: SYSTEM_USER`, `is_valid: true`, `expires_at: never (0)`,
and the four required scopes present.

Then smoke-test the live endpoint (session cookie required):

```bash
curl -s --cookie "session=<your-cookie>" \
  "https://aosom-sync.vercel.app/api/ads?resource=accounts" | jq
```

A non-empty `accounts` array (with `act_20658834`) confirms the new token works in prod.

## Checklist

- [ ] System User created + ad account `act_20658834`, app, catalog assigned
- [ ] Token generated with expiry **Never** and scopes `ads_read`, `ads_management`, `business_management`, `catalog_management`
- [ ] Updated `.env.local`
- [ ] Updated Vercel **Production** + redeployed
- [ ] Updated Vercel **Preview**
- [ ] `debug_token` shows `type: SYSTEM_USER`, `expires_at: never`
- [ ] `/api/ads?resource=accounts` returns `act_20658834`
- [ ] Done **before 2026-08-06**
