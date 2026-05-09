@AGENTS.md

# Aosom Sync

Catalogue management tool for a Shopify dropshipping store (27u5y2-kp.myshopify.com) sourcing from Aosom. Quebec market, French primary.

## Architecture

Next.js App Router on Vercel. Engine in `src/lib/`, UI in `src/app/(dashboard)/`, API in `src/app/api/`.

```
CSV Feed (Aosom) → csv-fetcher → variant-merger → diff-engine → Vercel Blob (Phase1Checkpoint)
                                       ↓                                  ↓
                                  catalog_snapshots (SQLite)      sync-refresh ×4 (2500 rows/chunk)
                                       ↓                                  ↓
                                  Catalog Browser UI              sync-finalize (rebuildCounts + notify)
                                       ↓
                               Import Pipeline → Claude API → Shopify (as draft)
```

Phase 1 is split into 3 cron functions to avoid Vercel 300s SIGKILL:
- `runSyncInit()` at 06:00 UTC — fetchAll + diff + save blob (~200s budget)
- `runSyncRefreshChunk()` at 06:20/06:40/07:00/07:20 UTC — 2500 rows/chunk (~200s budget each)
- `runSyncFinalize()` at 07:40 UTC — counts + price history + notify (~60s budget)

## Data Model (SQLite/better-sqlite3)

- `sync_runs` — audit log of daily sync executions
- `sync_logs` — per-field change records (price, images, status)
- `import_jobs` — import queue with status machine (pending→generating→reviewing→importing→done)
- `catalog_snapshots` — latest CSV data for fast catalog browsing
- `sync_cursor` — chunked sync progress for large stores
- `settings` — key-value store; `checkpoint_data` holds both `ShopifyPushCheckpoint` (Phase 2) and `Phase1Checkpoint` (Phase 1 chunked pipeline state)

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
- `GET /api/cron/sync` — Vercel Cron Phase 1 init: fetchAll + diff + save blob (Bearer CRON_SECRET, maxDuration 200s)
- `GET /api/cron/sync-refresh` — Vercel Cron Phase 1 chunk: refreshes 2500 rows/chunk, fires at 06:20/06:40/07:00/07:20 UTC (Bearer CRON_SECRET, maxDuration 200s)
- `GET /api/cron/sync-finalize` — Vercel Cron Phase 1 finalize: rebuildCounts + recordPriceChanges + notify, fires at 07:40 UTC (Bearer CRON_SECRET, maxDuration 60s)
- `POST /api/import/queue` — queue products by SKU array
- `POST /api/import/generate` — generate Claude content for one job
- `POST /api/import/push` — push reviewed job to Shopify

## Env Vars

- `SHOPIFY_ACCESS_TOKEN` — Shopify Admin API token
- `ANTHROPIC_API_KEY` — Claude API
- `CRON_SECRET` — Vercel Cron auth
- `AUTH_PASSWORD` — simple password auth for 2 users

## Testing

⚠️ Always use `bun run test` (executes `vitest run` via the npm script). Do NOT use `bun test` — bun's internal runner lacks `vi.stubGlobal` support and silently skips entire test files without error.

| Command | Runner | Result |
|---------|--------|--------|
| `bun run test` | vitest | ✅ correct |
| `bun run test:watch` | vitest --watch | ✅ correct |
| `bun run test:ci` | vitest --reporter=verbose | ✅ correct |
| `bun test` | bun:test | ❌ vi.stubGlobal crashes, tests skipped |

## Deployment

Vercel with `vercel.json` cron (daily at 6am UTC). Requires Vercel Pro for 60s function timeout.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
