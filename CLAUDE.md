@AGENTS.md

# Aosom Sync

Catalogue management tool for a Shopify dropshipping store (27u5y2-kp.myshopify.com) sourcing from Aosom. Quebec market, French primary.

## Architecture

Next.js App Router on Vercel. Engine in `src/lib/`, UI in `src/app/(dashboard)/`, API in `src/app/api/`.

```
CSV Feed (Aosom) → csv-fetcher → variant-merger → diff-engine → Shopify API
                                       ↓
                                  catalog_snapshots (SQLite)
                                       ↓
                                  Catalog Browser UI
                                       ↓
                               Import Pipeline → Claude API → Shopify (as draft)
```

## Data Model (SQLite/better-sqlite3)

- `sync_runs` — audit log of daily sync executions
- `sync_logs` — per-field change records (price, images, status)
- `import_jobs` — import queue with status machine (pending→generating→reviewing→importing→done)
- `catalog_snapshots` — latest CSV data for fast catalog browsing
- `sync_cursor` — chunked sync progress for large stores

## Key Patterns

- **French primary**: Shopify title/body in FR, English stored in metafields (`custom.title_en`, `custom.body_html_en`)
- **COLOR_MAP**: 2-letter SKU suffix → French color name (e.g., BK→Noir, GY→Gris). See `variant-merger.ts`
- **PSIN grouping**: Aosom's Parent SKU groups color/size variants. Fallback: parseSku()
- **Dropship**: `inventory_management: null`. Stock is NOT tracked in Shopify, only in catalog_snapshots
- **Draft imports**: All new products import as draft for manual review
- **[BRAND NAME]**: Aosom HTML descriptions contain this placeholder. Replaced with actual brand before Claude processing

## API Routes

- `GET /api/catalog` — browse catalog with filters (reads from Turso, not CSV)
- `POST /api/sync/trigger` — manual sync (supports `{dryRun: true}`)
- `GET /api/sync/history` — sync runs + change logs
- `GET /api/cron/sync` — Vercel Cron daily sync (Bearer CRON_SECRET)
- `POST /api/import/queue` — queue products by SKU array
- `POST /api/import/generate` — generate Claude content for one job
- `POST /api/import/push` — push reviewed job to Shopify

## Env Vars

- `SHOPIFY_ACCESS_TOKEN` — Shopify Admin API token
- `ANTHROPIC_API_KEY` — Claude API
- `CRON_SECRET` — Vercel Cron auth
- `AUTH_PASSWORD` — simple password auth for 2 users

## Deployment

Vercel with `vercel.json` cron (daily at 6am UTC). Requires Vercel Pro for 60s function timeout.
