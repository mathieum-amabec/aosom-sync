@AGENTS.md

# Aosom Sync

Catalogue management tool for a Shopify dropshipping store (27u5y2-kp.myshopify.com) sourcing from Aosom. Quebec market, French primary.

## Permissions

Claude Code has full autonomous permission to read, edit, create, and delete any file without confirmation prompts.

## Architecture

Next.js App Router on Vercel. Engine in `src/lib/`, UI in `src/app/(dashboard)/`, API in `src/app/api/`.

```
CSV Feed (Aosom) → csv-fetcher → variant-merger → diff-engine → Vercel Blob (Phase1Checkpoint)
                                       ↓                                  ↓
                                  catalog_snapshots (SQLite)      refreshProducts ×N (2500 rows/chunk)
                                       ↓                                  ↓
                                  Catalog Browser UI              rebuildCounts + notify
                                       ↓
                               Import Pipeline → Claude API → Shopify (as draft)
```

Phase 1 runs as a single Fluid Compute function (`runSyncFull`, maxDuration=800s, Vercel Pro):
- `runSyncFull()` at 06:00 UTC — init + sequential refresh chunks + finalize in one call
- `runSyncFull()` retry at 06:30 UTC — idempotent retry (skips if already finalized)
- `runSyncRefreshChunk()` / `runSyncFinalize()` — manual fallback routes only (not in cron schedule)

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
- `GET /api/cron/sync` — Vercel Cron: Fluid Compute Phase 1 orchestrator (init+chunks+finalize), fires at 06:00 + 06:30 UTC (Bearer CRON_SECRET, maxDuration 800s)
- `GET /api/cron/sync-refresh` — Manual fallback only: one refresh chunk (not in cron schedule since v0.4.0.0)
- `GET /api/cron/sync-finalize` — Manual fallback only: finalize step (not in cron schedule since v0.4.0.0)
- `POST /api/import/queue` — queue products by SKU array
- `POST /api/import/generate` — generate Claude content for one job
- `POST /api/import/push` — push reviewed job to Shopify

## Publication scheduling — `publication_queue` vs legacy `facebook_drafts`

Two publishing paths coexist. New work feeds the **publication queue**; the legacy
draft queue is kept only for the manual-schedule action and pre-existing rows.

- **Queue path (current):** `POST /api/social {action:"approve"}` enqueues the draft
  into `publication_queue` (platform `both`) on the next free slot from the configurable
  `publication_schedule` (settings, edited via `/api/settings/schedule`, computed by
  `getNextAvailableSlot` in `publication-scheduler.ts`). The draft stays `approved` in
  `facebook_drafts` — Approve no longer writes a `scheduled` facebook_draft.
  **`GET /api/cron/publisher`** (hourly) drains the queue and publishes.
- **Legacy path:** `POST /api/social {action:"schedule"}` (operator picks an explicit
  time) still writes `facebook_drafts.status='scheduled'`, and **`GET /api/cron/social-scheduled`**
  publishes those. `draft-scheduler.ts` (fixed M/W/F 15:00 UTC grid) backs only this path now.

⚠️ **`social-scheduled` is deprecated for Approve.** It remains live for the manual
`schedule` action and any `facebook_drafts` rows already `scheduled` before this change.
**Double-publish risk:** never both *approve* and *manually schedule* the same draft — it
would land in both `publication_queue` (→ `publisher`) and `facebook_drafts` (→
`social-scheduled`) and publish twice. Once the legacy `scheduled` rows have drained and the
manual `schedule` action is retired, `social-scheduled` + `draft-scheduler.ts` can be removed.

## Env Vars

- `SHOPIFY_ACCESS_TOKEN` — Shopify Admin API token
- `ANTHROPIC_API_KEY` — Claude API
- `CRON_SECRET` — Vercel Cron auth
- `AUTH_PASSWORD` — simple password auth for 2 users

## Dev Setup

Standard: `bun install`, then `bun run dev` / `bun run test`.

### Windows ARM64

Several native deps — `libsql`, `rolldown` (vitest), `@next/swc` — publish **no
`win32-arm64-msvc` build**, only `win32-x64-msvc`. The arm64 system Node/Bun can't
load them (`Cannot find module '@libsql/win32-arm64-msvc'`). Windows ARM emulates
x64, so run everything under an **x64 runtime**:

1. Install portable x64 runtimes (not committed to the repo):
   - Node x64 → `%USERPROFILE%\node-x64` (e.g. `node-v22.x-win-x64.zip` from nodejs.org)
   - Bun x64 → `%USERPROFILE%\bun-x64` (`bun-windows-x64.zip` from the bun releases)
2. Install deps under x64 Bun so the `win32-x64-msvc` bindings download:
   `& "$env:USERPROFILE\bun-x64\bun-windows-x64\bun.exe" install`
3. Run dev / tests via the wrappers (they select the x64 Node and guard on arch):
   - `.\dev.ps1` — `next dev` (forwards args, e.g. `.\dev.ps1 -p 3001`)
   - `.\test.ps1` — `vitest run` (forwards args, e.g. `.\test.ps1 tests/database.test.ts`)

   Override the Node location with `$env:AOSOM_NODE_X64` if you put it elsewhere.

Note: libsql's `client.close()` doesn't release the `.sqlite` file handle
synchronously on Windows, so file-backed test DBs hit `EBUSY` on cleanup. The
libsql-backed test suites use `:memory:` DBs to avoid this.

## Testing

⚠️ Always use `bun run test` (executes `vitest run` via the npm script). Do NOT use `bun test` — bun's internal runner lacks `vi.stubGlobal` support and silently skips entire test files without error.

| Command | Runner | Result |
|---------|--------|--------|
| `bun run test` | vitest | ✅ correct |
| `bun run test:watch` | vitest --watch | ✅ correct |
| `bun run test:ci` | vitest --reporter=verbose | ✅ correct |
| `bun test` | bun:test | ❌ vi.stubGlobal crashes, tests skipped |

## Deployment

Vercel with `vercel.json` cron (daily at 6am UTC). Requires Vercel Pro for Fluid Compute (maxDuration 800s).

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
