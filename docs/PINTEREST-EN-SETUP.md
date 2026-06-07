# Pinterest — Second (English) Catalog Feed

Aosom Sync serves two Pinterest catalog feeds. The FR feed is already connected;
this guide adds the **English** feed so the catalog also reaches the anglophone
Canadian audience. The procedure is identical to the FR feed — only the URL,
language, and country differ.

| | FR feed (already configured) | EN feed (this guide) |
|---|---|---|
| URL | `https://aosom-sync.vercel.app/api/feeds/pinterest` | `https://aosom-sync.vercel.app/api/feeds/pinterest-en` |
| Language | French | **English** |
| Country | Canada | **Canada** |

The EN feed is the same catalog and RSS shape as the FR feed; the only difference
is that product titles come from the `custom.title_en` metafield (falling back to
the French title when an English title is missing). Both feeds are public, CDN
cached for 24h, and refresh daily. (Shipped in PR #101 — see `FEEDS-SETUP.md` for
how the feeds are generated.)

## Prerequisites

- A **Pinterest Business** account with the storefront domain (`ameublodirect.ca`)
  already **claimed and verified** — done when the FR feed was set up. No need to
  re-verify for the second feed.
- Access to **Pinterest Catalogs** (Ads → Catalogs, or business.pinterest.com →
  Catalogs).

## Steps

1. Go to **[Pinterest Catalogs](https://www.pinterest.com/business/catalogs/)**
   (Ads menu → *Catalogs*).
2. Click **Add a data source** (or *Connect a data source* if this is an
   additional feed).
3. Choose **Add by URL** / scheduled feed and paste the EN feed URL:

   ```
   https://aosom-sync.vercel.app/api/feeds/pinterest-en
   ```

4. Set the feed settings:
   - **Language:** `English (US)`
   - **Country / region:** `Canada`
   - **Currency:** `CAD` (the feed already prices in CAD)
5. Set the fetch **schedule to Daily** (the feed is regenerated from Shopify and
   CDN-cached 24h, so a daily pull is enough).
6. Name the source something distinguishable, e.g. **`Ameublo Direct — EN (Canada)`**,
   so it's not confused with the FR source.
7. Submit. Pinterest validates the feed and begins ingestion (first processing can
   take a few hours).

## Verify

Confirm the feed responds before connecting (and any time after):

```bash
curl -s -o /dev/null -w "HTTP=%{http_code} size=%{size_download}B\n" \
  "https://aosom-sync.vercel.app/api/feeds/pinterest-en"
```

A healthy feed returns `HTTP=200` with a non-trivial size. To eyeball the English
titles:

```bash
curl -s "https://aosom-sync.vercel.app/api/feeds/pinterest-en" | grep -m3 "<title>"
```

In Pinterest, the source should move to **Active / Completed** with a product
count close to the FR feed's (products without an `custom.title_en` metafield fall
back to the French title, so both feeds carry the full catalog).

## Notes

- **Two sources, one catalog:** keeping FR and EN as separate language/country
  sources lets Pinterest serve the right-language product to each audience.
- **Titles:** English titles depend on the `custom.title_en` metafield being
  populated on the product in Shopify. Products missing it still appear, using the
  French title — so coverage is never lost, only localization.
- **Troubleshooting:** if Pinterest reports 0 products, re-run the `curl` check
  above; a `200` with content means the feed is fine and the issue is on the
  Pinterest source config (wrong URL, unverified domain, or still processing).
