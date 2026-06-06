# furnishdirect.ca — EN domain setup

Goal: point **furnishdirect.ca** at the English version of the Shopify store
(primary store is **ameublodirect.ca**, locales: `fr` primary + `en` published).

> ## ✅ Markets scopes — GRANTED (verified 2026-06-06)
> Mat updated the token; the GraphQL `markets` query now succeeds (`read_markets` granted).
> The only remaining blocker is that **furnishdirect.ca is not yet connected to the shop as
> a domain** — and connecting a domain is a manual DNS + Shopify-admin step, not an Admin-API
> operation. Once it's connected, attaching it to a market is a one-call API mutation.

## API investigation — UPDATED 2026-06-06 (post-scope-grant, read-only)

| Check | Result |
| --- | --- |
| GraphQL `markets { … }` | ✅ **succeeds** — `read_markets` granted |
| Markets present | exactly one: **"Canada"** (`gid://shopify/Market/35882270825`), primary + enabled |
| Web presences | primary domain `ameublodirect.ca` only |
| Hosts across shop + all markets | `ameublodirect.ca` only — **`furnishdirect.ca` is NOT connected** |
| `GET /admin/api/2025-01/domains.json` (REST) | 404 (REST domains unavailable on this version) — used GraphQL instead |

**Conclusion:** scopes are no longer the blocker. The blocker is that **furnishdirect.ca is
not connected to the shop**. The Admin API can *attach* an already-connected domain to a
market, but it cannot *connect* a new domain — that requires DNS at the registrar +
verification in Shopify admin. So the next step is manual; after it, the attach is one API call.

## Next steps

### 1. Connect furnishdirect.ca (manual — Mat)
- **DNS** at the registrar: `A @ → 23.227.38.65`, `CNAME www → shops.myshopify.com`.
- **Shopify Admin → Settings → Domains → Connect existing domain** → `furnishdirect.ca`.
  Wait for SSL to provision.

### 2. Attach it to the Canada market as the EN web presence (API — automatable now)
Once the domain is connected (so it has a domain id), this becomes a single GraphQL mutation
against the existing **Canada** market — the store stays one market with two web presences:
`ameublodirect.ca` (FR) + `furnishdirect.ca` (EN):

```graphql
mutation {
  marketWebPresenceCreate(
    marketId: "gid://shopify/Market/35882270825"
    webPresence: { domainId: "<furnishdirect.ca connected domain id>", defaultLocale: "en", alternateLocales: [] }
  ) {
    market { id name }
    webPresence { id domain { host } defaultLocale { locale } }
    userErrors { field message }
  }
}
```

Ping me once furnishdirect.ca shows as connected in Settings → Domains and I'll run this
mutation (I'll resolve the connected domain id and confirm the FR/EN split). Field names
should be validated against the API version in use at run time (`marketWebPresenceCreate`
input shape has changed across versions).

> Note: the storefront analytics + dashboard links use `ameublodirect.ca`. Once
> `furnishdirect.ca` is live for EN, revisit the Umami `data-domain` (see
> `docs/UMAMI-SETUP.md`) if you want EN traffic tracked separately.
