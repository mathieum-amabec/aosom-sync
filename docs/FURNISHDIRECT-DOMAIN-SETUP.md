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

## Steps (in order) — now that `read_markets` + `write_markets` are granted

**Step 1 — DNS (manual, at the registrar).** Point `furnishdirect.ca` at Shopify:
   - `A` record `@` → `23.227.38.65`
   - `CNAME` `www` → `shops.myshopify.com`

   Allow up to a few hours for propagation. Verify with `nslookup furnishdirect.ca`
   (should resolve to `23.227.38.65`).

**Step 2 — Connect the domain (manual, Shopify Admin).** Settings → **Domains** →
   **Connect existing domain** → `furnishdirect.ca`. Shopify checks the DNS records
   above and provisions an SSL certificate. Wait until it shows **Connected** with SSL
   active (the REST `/domains.json` endpoint is gone on `2025-01`, so confirm in the
   Admin UI, not via REST).

**Step 3 — Bind `furnishdirect.ca` → EN on the Canada market (scriptable).** Once the
   domain is connected, Claude Code can run the binding instead of clicking through the
   Admin. A Shopify market can hold **multiple web presences, one per domain**, so we add
   a *second* web presence on the existing **Canada** market — no new market (CA already
   belongs to Canada). The existing `ameublodirect.ca` → FR presence is untouched.

   ```bash
   # dry-run first — prints the exact mutation + resolved marketId/domainId
   node scripts/bind-furnishdirect-domain.mjs
   # then apply
   node scripts/bind-furnishdirect-domain.mjs --apply
   ```

   The script (`scripts/bind-furnishdirect-domain.mjs`) preflights scopes, finds the
   Canada market, resolves the `furnishdirect.ca` domain id, refuses to run twice (exits
   if already bound), and — if the domain isn't connected yet — prints the connect steps
   and exits without mutating anything. Pass `--domain-id gid://shopify/Domain/XXX` if
   auto-discovery can't find it.

**Cross-region alternative.** If EN is meant for a **different region** (e.g. US /
   International) rather than English-Canada, create a dedicated market instead:
   `marketCreate(input: { name: "International (EN)", handle: "intl-en", regions: [...] })`
   then `marketWebPresenceCreate` binding `furnishdirect.ca` + `defaultLocale: en`. That
   path does not conflict with the Canada market.

## API path (the mutation the script runs)

`marketWebPresenceCreate` adds the EN web presence to the Canada market:

```graphql
# 1. Find the Canada market id + its current web presences (avoid a duplicate)
query {
  markets(first: 50) {
    nodes {
      id name primary
      webPresences(first: 10) { nodes { id domain { host } defaultLocale { locale } } }
      regions(first: 50) { nodes { ... on MarketRegionCountry { code } } }
    }
  }
}

# 2. Create a second web presence on the Canada market, bound to furnishdirect.ca, EN
mutation marketWebPresenceCreate($marketId: ID!, $webPresence: MarketWebPresenceCreateInput!) {
  marketWebPresenceCreate(marketId: $marketId, webPresence: $webPresence) {
    market { id webPresences(first: 10) { nodes { id domain { host } defaultLocale { locale } } } }
    userErrors { field message }
  }
}
# variables:
# { "marketId": "gid://shopify/Market/35882270825",
#   "webPresence": { "domainId": "gid://shopify/Domain/XXX", "defaultLocale": "en" } }
```

> Analytics note: storefront analytics + dashboard links use `ameublodirect.ca`. Once
> `furnishdirect.ca` is live for EN, revisit the Umami `data-domain`
> (see `docs/UMAMI-SETUP.md`) if you want EN traffic tracked separately.
