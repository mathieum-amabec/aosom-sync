# furnishdirect.ca — EN domain setup

Goal: serve the **English** storefront on **furnishdirect.ca**, keeping the French
storefront on **ameublodirect.ca** (primary). Store: *Ameublo Direct*, locales
`fr` (primary, published) + `en` (published).

## API state (verified 2026-06-07, read-only)

| Check | Result |
| --- | --- |
| Token scopes (`currentAppInstallation.accessScopes`) | ✅ **`read_markets` + `write_markets` now granted** (the 2026-06-06 403 is resolved) |
| GraphQL `markets` | ✅ readable — **one market**: "Canada" (`gid://shopify/Market/35882270825`), handle `ca`, **primary**, enabled, region **[CA]** |
| `shopLocales` | `fr` (primary, published), `en` (published) |
| `shop.primaryDomain` | `ameublodirect.ca` |
| `GET /admin/api/2025-01/domains.json` (REST) | **404** — REST domains endpoint is gone on this version; use the Admin UI or GraphQL web-presence fields |
| `furnishdirect.ca` connected? | **NO** — not a connected domain yet (DNS pending) |

Scripts: `scripts/markets-status.mjs` (read markets/locales) and the scope probe inline.

## Why we did NOT create a "second EN market"

**Shopify markets are region-scoped: a country can belong to only one market.** Canada
(CA) is already owned by the primary "Canada" market, so creating a second market that
also targets Canada is rejected (region conflict) — *even though* the token now has
`write_markets`.

For **one country, two languages, two domains**, the correct model is **one market
(Canada) with two locales**, mapping a domain to each language:

- `ameublodirect.ca` → **FR**
- `furnishdirect.ca` → **EN**

A separate `marketCreate` is only appropriate if the EN site targets a **different
region** (e.g. a "United States" / "International" market). If that's the intent, say so
and we create that market with its own region + `en` default locale — that path does not
conflict with the Canada market.

Either way, the blocker right now is the same: **furnishdirect.ca must be connected as a
domain before its web presence can be configured.**

## Steps (manual, in order) — once you're ready

1. **DNS** — at the `furnishdirect.ca` registrar, point it at Shopify:
   - `A` record `@` → `23.227.38.65`
   - `CNAME` `www` → `shops.myshopify.com`
2. **Connect the domain** — Shopify Admin → **Settings → Domains → Connect existing
   domain** → `furnishdirect.ca`. Wait for SSL to provision.
3. **Map it to English** — Admin → **Settings → Markets → Canada → Domains and
   languages**:
   - Keep `ameublodirect.ca` as the **French** domain.
   - Assign `furnishdirect.ca` as the **English** domain (dedicated domain, not a
     subfolder). EN visitors then land on `furnishdirect.ca`, FR on `ameublodirect.ca`.
   - Note: dedicated per-language top-level domains within one market may require a
     Shopify plan that supports international domains; if unavailable, the fallback is a
     subfolder (`ameublodirect.ca/en`) and `furnishdirect.ca` set to redirect/forward.
4. (Cross-region alternative) If EN is meant for a **different region** rather than
   English-Canada, create a dedicated market instead (see API path below).

## API path (now scriptable — scopes are granted)

Once `furnishdirect.ca` is connected (step 2), the web-presence binding can be scripted.
Inspect the Canada market's web presence and locales, then bind the EN domain:

```graphql
# 1. Find the Canada market's web presence id
query {
  markets(first: 10) { nodes { id name webPresence { id rootUrls { url locale } } } }
}

# 2. Bind furnishdirect.ca to the EN locale of the Canada market
#    (exact input shape depends on API version — confirm against the
#     marketWebPresenceUpdate / domain targeting docs for 2025-01).
mutation {
  marketWebPresenceUpdate(
    webPresenceId: "gid://shopify/MarketWebPresence/XXX",
    input: { /* domainId for furnishdirect.ca + alternateLocales/defaultLocale EN */ }
  ) { userErrors { field message } }
}
```

For the **cross-region** alternative (separate EN market), the mutation is
`marketCreate(input: { name: "International (EN)", handle: "intl-en", regions: [...],
... })` followed by `marketWebPresenceCreate` binding `furnishdirect.ca` + `defaultLocale: EN`.

> Analytics note: storefront analytics + dashboard links use `ameublodirect.ca`. Once
> `furnishdirect.ca` is live for EN, revisit the Umami `data-domain`
> (see `docs/UMAMI-SETUP.md`) if you want EN traffic tracked separately.
