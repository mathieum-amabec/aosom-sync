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
                               Import Pipeline → Claude API → Shopify (as active/live)
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
- **Active imports**: New products are auto-published as `active` (live) on import — `createShopifyProduct` sets `status: "active"` (see `shopify-client.ts`; switched from draft→active in commit beb00b4, 2026-06-07). No manual-review draft step.
- **[BRAND NAME]**: Aosom HTML descriptions contain this placeholder. Replaced with actual brand before Claude processing

## Meta Pixel (two parts — web dataset `214720653324969`)

- **Storefront events (PageView / ViewContent / AddToCart)**: a Shopify **ScriptTag**
  (id `222592598121`) pointing at `/api/pixel/script` (see `src/app/api/pixel/script/route.ts`,
  installed via `/api/pixel/install`). `content_ids` everywhere = `variant.sku` (matches the
  Meta catalog `retailer_id`, e.g. `01-0901` — NOT the numeric `variant.id`).
- **Purchase**: a **Custom Web Pixel installed MANUALLY** in **Shopify Admin → Settings →
  Customer events → Add custom pixel** — there is **no code path or Admin API that creates it**.
  The source of truth for the pasted code is `docs/meta-custom-web-pixel.js`; editing that repo
  file does nothing until an operator pastes it into the pixel manager and re-Saves.
  ScriptTags no longer run on the Checkout-Extensibility Thank-You page, so Purchase cannot live
  in the ScriptTag. The custom pixel runs in Shopify's **lax sandbox** (iframe, no top-frame
  DOM), so it sends Purchase via `fetch()` to `https://www.facebook.com/tr/` (the noscript
  beacon) — NOT the `fbq`/`fbevents.js` SDK, which the sandbox rejects.

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

## Publication scheduling — `publication_queue` (unified)

All publishing now flows through the **publication queue**. The legacy
`facebook_drafts.status='scheduled'` path is retired: its cron
(`/api/cron/social-scheduled`) was removed from `vercel.json` (v0.5.53.93), so a
`scheduled` row would never publish.

- **Approve:** `POST /api/social {action:"approve"}` enqueues the draft into
  `publication_queue` (one item per active brand) on the next free slot from the
  configurable `publication_schedule` (settings, edited via `/api/settings/schedule`,
  computed by `getNextAvailableSlot` in `publication-scheduler.ts`). The draft stays
  `approved` in `facebook_drafts`. The `/drafts`-page approve server action
  (`drafts/actions.ts`) auto-enqueues `content_template` drafts the same way.
- **Manual schedule (operator picks a time):** both `POST /api/social {action:"schedule"}`
  and `POST /api/social/drafts/:id/schedule` enqueue into `publication_queue` at the chosen
  time (cancel-then-enqueue via `cancelPendingQueueItems`, so re-scheduling moves the post
  instead of duplicating it). The draft stays `approved` — neither writes
  `status='scheduled'` anymore. `DELETE /api/social/drafts/:id/schedule` cancels the draft's
  pending queue rows and reverts it to `draft`.
- **Publish:** **`GET /api/cron/publisher`** (hourly) drains the queue and publishes.

Slot collisions are rejected by `publication_queue`'s partial-unique index as
`QueueSlotTakenError`: approve retries the next free slot; the explicit-time schedule
paths skip the colliding brand (they can't shift the operator's chosen time).

**Cleanup (done):** `/api/cron/social-scheduled` and `processScheduledDrafts()` have been
removed — nothing writes or drains `facebook_drafts.status='scheduled'` anymore.
`draft-scheduler.ts` is **kept**: `isSqliteUtc` (validates queue slots in `addToQueue`) and
`nextFreeSlot` (used by `/api/queue/add`) are live. The `scheduled` status value survives only
for any historical rows; no code produces new ones.

## Env Vars

- `SHOPIFY_ACCESS_TOKEN` — Shopify Admin API token
- `ANTHROPIC_API_KEY` — Claude API
- `CRON_SECRET` — Vercel Cron auth
- `AUTH_PASSWORD` — simple password auth for 2 users
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (Phase1Checkpoint + demand-gen video assets)

⚠️ **Demand-gen uploads need a PUBLIC Blob store.** `scripts/upload-demand-gen.mjs` calls
`put(..., { access: "public" })` because Meta/YouTube ad ingest fetch the asset `file_url`
directly — a private store rejects the upload with `Cannot use public access on a private store`.
The canonical public store is `jcskqp8orcub9i0l.public.blob.vercel-storage.com` (token prefix
`vercel_blob_rw_jcSkqp8…`). Some clones' `.env.local` carry a **different, private** store token
(e.g. `…elo1Mrx…`) and will fail every upload. If uploads fail this way, run with the public-store
token, e.g. `BLOB_READ_WRITE_TOKEN=<public-token> node-x64 scripts/upload-demand-gen.mjs --apply`.

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
