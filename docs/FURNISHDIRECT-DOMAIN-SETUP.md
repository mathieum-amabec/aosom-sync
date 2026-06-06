# furnishdirect.ca — EN domain setup

Goal: point **furnishdirect.ca** at the English version of the Shopify store
(primary store is **ameublodirect.ca**, locales: `fr` primary + `en` published).

> ## ⚠️ ACTION REQUIRED (Mat) — add Markets scopes
> The Shopify access token currently lacks **`read_markets`** and **`write_markets`**, so
> the Markets API returns 403 and furnishdirect.ca can't be configured programmatically.
> Add both scopes the same way as the previous scope updates: **Shopify Admin → Settings →
> Apps and sales channels → Develop apps → [the custom app] → Configuration → Admin API
> integration → edit scopes → add `read_markets` + `write_markets` → Save → reinstall the
> app to issue a new token**, then sync the new token (incl. Vercel) as before.
> Once granted, the API path below can be scripted; until then, use the manual steps.

## API investigation (2026-06-06, read-only)

| Check | Result |
| --- | --- |
| `GET /admin/api/2025-01/domains.json` (REST) | **404** — domains are not exposed on this REST version |
| GraphQL `markets { … }` | **403 ACCESS_DENIED** — requires `read_markets` (+ `write_markets` to configure) |
| `shop.primaryDomain` | `ameublodirect.ca` |
| `shopLocales` | `fr` (primary, published), `en` (published) |

**Conclusion:** the current Shopify access token **cannot read or configure Markets**
(missing `read_markets` / `write_markets`), and the REST domains endpoint isn't available.
So furnishdirect.ca cannot be wired up via the API with the current credentials. This is a
manual/scoped operation for Mat.

## Manual steps for Mat

1. **DNS** — at the registrar for `furnishdirect.ca`, point it at Shopify:
   - `A` record `@` → `23.227.38.65`
   - `CNAME` `www` → `shops.myshopify.com`
2. **Add the domain in Shopify** — Admin → **Settings → Domains → Connect existing domain**
   → `furnishdirect.ca`. Wait for SSL to provision.
3. **Attach it to an English market** — Admin → **Settings → Markets**:
   - Use (or create) a market whose **default/primary language is English**.
   - Under that market's **Domains and languages**, set its web presence to
     `furnishdirect.ca` with default locale **EN** (the "subfolder vs domain" choice →
     pick the dedicated domain `furnishdirect.ca`).
4. (Optional) Set `ameublodirect.ca` to default **FR** so the two domains map cleanly
   FR↔EN.

## To automate later (API path)

If you want this scripted, grant the custom app these scopes, then it can be done via the
GraphQL Admin API:

- `read_markets`, `write_markets`
- (domain attach is done through `webPresence` on the market: `marketWebPresenceCreate` /
  `marketWebPresenceUpdate`, referencing the connected domain)

Once `write_markets` is granted, a follow-up script can: look up the EN market →
`marketWebPresenceUpdate` to bind `furnishdirect.ca` + `defaultLocale: EN`. Until then, the
steps above are manual in the Shopify admin.

> Note: the storefront analytics + dashboard links use `ameublodirect.ca`. Once
> `furnishdirect.ca` is live for EN, revisit the Umami `data-domain` (see
> `docs/UMAMI-SETUP.md`) if you want EN traffic tracked separately.
