# Product Feeds — Setup Guide

Aosom Sync exposes the Ameublo Direct catalog as three product feeds, one per ad
platform. They are **live in production** (shipped in PR #89) and need no further
code — this guide covers connecting each platform to its feed.

## Feeds at a glance

| Platform | Endpoint | Format | Content-Type |
|----------|----------|--------|--------------|
| Google Merchant Center | `https://aosom-sync.vercel.app/api/feeds/google` | RSS 2.0 XML (`g:` namespace) | `application/xml` |
| Pinterest Catalog | `https://aosom-sync.vercel.app/api/feeds/pinterest` | RSS 2.0 XML (`g:` namespace) | `application/xml` |
| Pinterest Catalog (EN) | `https://aosom-sync.vercel.app/api/feeds/pinterest-en` | RSS 2.0 XML (`g:` namespace) | `application/xml` |
| Meta Product Catalog | `https://aosom-sync.vercel.app/api/feeds/meta` | JSON array | `application/json` |

The **Pinterest EN** feed is identical to the Pinterest feed except titles come
from the `custom.title_en` metafield (falling back to the FR title when absent),
to maximize reach with the anglophone Canadian audience. Connect it as a second
Pinterest catalog source.

All feeds are **public** (no auth) so the platforms can fetch them directly.

### Validation snapshot — 2026-06-07

| Feed | HTTP | Well-formed | Products |
|------|------|-------------|----------|
| Google | 200 | yes (RSS 2.0) | 966 |
| Pinterest | 200 | yes (RSS 2.0) | 966 |
| Meta | 200 | yes (JSON) | 966 |

Sample items (identical across all three feeds):

```
845-335        Agenouilloir de jardin pliable avec coussin mousse EVA   49.99 CAD   in stock
844-814V01ND   Allée de jardin bois déroulable 120 cm                   44.99 CAD   in stock
D30-927V00LG   Arbre à chat multi-niveaux 168 cm avec condos et hamacs  124.99 CAD  in stock
```

Re-validate any time:

```bash
for f in google pinterest meta; do
  curl -s -o /dev/null -w "$f: HTTP=%{http_code} size=%{size_download}B\n" \
    "https://aosom-sync.vercel.app/api/feeds/$f"
done
```

### How the feeds behave

- **Source:** generated from the Shopify catalog kept in sync by the daily sync job.
  Each variant with a non-empty SKU becomes a feed item.
- **Currency:** CAD. **Brand:** the product's vendor, falling back to `Aosom`.
- **Availability:** untracked inventory is treated as `in stock` (dropship default);
  tracked inventory at quantity ≤ 0 is `out of stock`.
- **Caching:** each feed is CDN-cached for 24h (`s-maxage=86400`,
  `stale-while-revalidate=43200`). Set every platform to fetch **daily** — fetching
  more often just returns the cached copy.
- **IDs:** the item `id` is the product SKU (e.g. `845-335`), stable across feeds —
  so the same product reconciles across Google, Pinterest, and Meta.

---

## Google Merchant Center

1. Create an account at [merchants.google.com](https://merchants.google.com).
2. **Verify and claim the domain** `ameublodirect.ca` (Business info → ensure the
   website is verified; use the HTML tag or Search Console method).
3. Add the feed: **Products → Feeds → + (Primary feed)**
   - Country of sale: **Canada**
   - Language: **French (fr)**
   - Feed name: `Ameublo Direct — primary`
   - Connection method: **Scheduled fetch**
   - File URL: `https://aosom-sync.vercel.app/api/feeds/google`
   - Fetch frequency: **Daily** (the feed refreshes once per 24h)
4. Enable **Google Shopping** ads for the target country: **Canada**.
5. After the first fetch, check **Products → Diagnostics** for disapprovals
   (missing GTIN, image issues, policy). The feed already provides
   `g:id`, `title`, `description`, `g:price`, `g:availability`, `g:image_link`,
   `g:brand`, and `g:google_product_category`.

---

## Pinterest Catalog

1. Open **Pinterest Business → Catalogs**.
2. Add a data source:
   - Data source URL: `https://aosom-sync.vercel.app/api/feeds/pinterest`
   - Format: **RSS / XML**
   - Currency: **CAD**
   - Refresh: **Daily**
3. Wait for the first ingestion to complete (Pinterest validates the feed and
   reports item-level errors in the Catalogs dashboard).
4. Create **product groups** by category to organize shopping ads and
   collections (e.g. Jardin, Mobilier, Animaux), filtering on product attributes.

---

## Meta Product Catalog

1. Open **Meta Business Suite → Commerce Manager → Catalog**.
2. Add a data source → **Data feed**:
   - Feed URL: `https://aosom-sync.vercel.app/api/feeds/meta`
   - Format: **JSON** (a flat array of product objects)
   - Currency: **CAD**
   - Upload schedule: **Daily**
3. Connect the catalog to the Meta Pixel **`2027065584856990`**
   (Catalog → Settings → Connected assets / Events).
4. Enable **Advantage+ catalog ads (Dynamic Ads)** so the catalog can power
   retargeting and prospecting campaigns.

> Field mapping is automatic: the JSON keys (`id`, `title`, `description`,
> `availability`, `condition`, `price`, `link`, `image_link`, `brand`,
> `google_product_category`, `additional_image_link`) match Meta's catalog schema.

---

## Maintenance & troubleshooting

- **Feed shows stale data:** the CDN caches for 24h. A platform fetch right after a
  catalog change may still serve the previous copy — it reconciles on the next
  daily fetch. To confirm the live feed, append a cache-busting query (e.g.
  `?t=1`) when fetching manually.
- **Feed returns 500 (`Feed temporarily unavailable`):** transient generation
  error (e.g. upstream catalog read). The platform retries on its schedule; the
  error response is sent with `no-store` so it is never cached.
- **Product missing from a feed:** check the variant has a non-empty SKU and the
  product exists in the synced catalog. Items without a SKU are skipped.
- **Wrong availability:** dropship products are usually untracked and reported
  `in stock`; only tracked variants at quantity ≤ 0 report `out of stock`.
- **Product count sanity check:** all three feeds should report the same count
  (966 on 2026-06-07). A large divergence between feeds indicates a
  generation problem in one format.
