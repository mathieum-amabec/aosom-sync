# Changelog

All notable changes to Aosom Sync will be documented in this file.

## [0.5.12.0] - 2026-06-03

### Fixed
- **Idempotent import** — `importToShopify` no longer creates duplicate Shopify
  products. A job that already produced a `shopify_id` returns early
  (`already_imported`), and `queueForImport` skips any SKU already mapped to a
  `shopify_product_id`. Closes the failure mode where re-importing an existing SKU
  created a fresh product (new ID) stripped of its manual tags/metafields.
- **`package.json` version drift** — synced `package.json` (was stuck at `0.5.1.0`)
  to the `VERSION` file, so the health endpoint reports the real version again.

### Added
- `scripts/taxonomy-audit.js` (read-only) and `scripts/taxonomy-build.js`
  (idempotent, dry-run by default; `--apply` to write) — reusable tooling for the
  outdoor-collection taxonomy work.
- `docs/taxonomy-changelog.md` — audit trail of the Shopify-side taxonomy operations
  (5B smart-collection migration, 5C new outdoor collections, 5D handle fix + 301
  redirect, and the 25/25 EN collection-title translations).
- `tests/import-pipeline.test.ts` — 4 tests covering both import idempotency guards.

## [0.5.11.0] - 2026-06-02

### Added
- **`scripts/migrate-existing-products.ts`** — retroactively applies product-naming-v2
  (brand-free titles + native SEO metafields) to already-imported Shopify products.
  Reconstructs each product's Aosom source from the DB (by `shopify_product_id`, falling
  back to SKU), regenerates content with `generateProductContent`, and writes the title +
  SEO metafields. **Never touches the URL handle** (SEO-indexed). Modes:
  - `DRY_RUN=true` (default) — writes a CSV report, no Shopify writes.
  - `APPLY_FROM_CSV=<csv>` — applies already-reviewed content straight from a dry-run CSV
    (no Claude calls): title + `global.title_tag` / `global.description_tag` /
    `custom.title_en` / `custom.meta_description_fr`.
  - `RESUME_CSV=<csv>` — skips `shopify_id`s already present (resume an interrupted run).
  - `CANARY=N` — apply to the first N rows only.
  - Aborts after >10 consecutive errors (network-outage guard).
- **`scripts/verify-products.ts`** — read-only check of a product's title/handle + SEO
  metafields, for before/after migration verification.

### Changed
- **Anthropic client now has a 60s timeout + 3 retries** (`content-generator.ts`). A
  network blip fails fast and retries instead of hanging the process on a half-open
  socket (this previously froze a long migration run indefinitely).

### Notes
- Production migration run: **566 / 577 products migrated** (titles v2, native SEO, no
  supplier brand), 0 errors. 11 not migrated: 4 test placeholders + 6 delisted Outsunny
  products (no Aosom DB source) + 1 invalid-JSON generation error.
- Known gap: `custom.meta_description_en` keeps its old (brand-y) text — the dry-run CSV
  did not capture the EN meta description. A separate pass is planned.

## [0.5.10.0] - 2026-06-02

### Added
- **Image selection at import (Étape 1).** `selectProductImages()` curates a
  product's image list before it becomes a draft: drops images whose URL exposes
  a dimension `< 800px` (kept when size is undetectable — no per-image HEAD
  requests), promotes a `lifestyle`/`ambiance`/`room` image to position 1, and
  caps at **8 images**.
- **`scripts/dry-run-image-selection.ts`** — before/after dry-run against a local
  feed copy, using the real selection function. No Shopify writes.

### Notes
- Applied **only** in `queueForImport` (import/create path), never in
  `mergeVariants` — `mergeVariants` also feeds the daily sync diff, so filtering
  there would re-image products that are already live (that is Étape 4).
- On the current Aosom feed the **size filter and lifestyle promotion are no-ops**:
  image URLs are opaque hashes (`img-us.aosomcdn.com/100/…`) with no dimensions or
  scene keywords. They are forward-compatible if such URLs ever appear.
- The **8-image cap is the active rule**: a dry-run over 5,132 products / 69,095
  image URLs showed 2,415 products (47%) currently exceed 8 images (up to 119).

## [0.5.9.0] - 2026-06-02

### Changed
- **Product titles no longer carry the supplier brand.** Titles now follow a strict
  `[product type] [feature] [size] — [color]` pattern (product type first for SEO,
  max 10 words, no brand, no model number). The supplier brand (Outsunny, HOMCOM, …)
  moves to the Shopify `vendor` field and a `custom.brand_fr` metafield instead of
  cluttering the customer-facing title.

### Added
- **Native Shopify SEO.** Generates `global.title_tag` (≤65 chars, brand-suffix
  preserved via `clampMetaTitle`) and `global.description_tag` (≤155 chars), plus
  EN equivalents in `custom.meta_title_en` / `custom.meta_description_en` for later
  translation.
- **URL handles.** A `slugify`'d, accent-stripped, brand-free kebab-case handle per
  language, set on the product at creation.

### Fixed
- **Empty / stale metafield values no longer 422 the entire product create.** Import
  jobs generated before this feature lacked the new SEO fields and reached Shopify as
  `undefined` metafield values, failing the whole `POST /products.json`. `createShopifyProduct`
  now drops empty-valued metafields and falls back to a title-derived handle; `importToShopify`
  backfills missing SEO fields on stale content with safe defaults.

### Known issues
- `extractBrand` resolves a real supplier brand for only ~10% of products; the other
  ~90% fall back to `vendor = "Aosom"` (deliberate, to match historical DB data and
  avoid false-positive description diffs — see csv-fetcher.ts BUG-C-STEP3). Improving
  brand coverage is tracked as separate work.

## [0.5.8.0] - 2026-06-02

### Fixed
- **compare_at_price discount threshold.** `compare_at_price` was set on ANY price
  drop (even 1%), producing fake "sales" that erode credibility, plus a batch of
  corrupted values (compare_at far below the real price). Now a struck-through "was"
  price renders only for a genuine discount >= `MIN_DISCOUNT_DISPLAY_PERCENT`
  (default 10%, overridable via env); smaller dips and price increases clear it.
  NaN-guarded so a malformed env var falls back to 10 instead of silently disabling
  every sale price.

### Added
- **`scripts/clean-compare-at-price.ts`** — one-shot, dry-run-by-default retroactive
  cleanup that clears invalid (`compare_at <= price`) or sub-threshold
  `compare_at_price` on existing Shopify variants (2 req/s, gitignored report).
  First run cleared 70 of 101 variants (6 corrupted + 64 sub-threshold); 31 genuine
  discounts kept.

## [0.5.7.0] - 2026-05-31

### Fixed
- **Windows ARM64 local dev** (x64 portable runtimes + `dev.ps1`/`test.ps1`).
  Native deps (`libsql`, `rolldown`, `@next/swc`) ship no `win32-arm64-msvc`
  build, so dev/test failed under the arm64 system Node/Bun
  (`Cannot find module '@libsql/win32-arm64-msvc'`). Windows ARM emulates x64,
  so added `dev.ps1`/`test.ps1` wrappers that run under a portable x64 Node
  (with an arch guard and `AOSOM_NODE_X64` override) and documented the setup in
  `CLAUDE.md`. Switched the libsql-backed test suites to in-memory DBs to dodge a
  Windows `EBUSY` file-lock (libsql's `close()` doesn't release the file handle
  synchronously). Also fixed `content-templates` route test mocks
  (`getRecentlyUsedHookIds` + `recordHookUsage`, 4-arg `selectCompatibleHooks`)
  that drifted in 0.5.5.0 and left the suite red.

## [0.5.6.0] - 2026-05-28

### Added
- **Meta Pixel integration.** Installs the Meta (Facebook) Pixel on the Shopify
  storefront via the ScriptTag API, toggled by `NEXT_PUBLIC_META_PIXEL_ID`.
  - `src/lib/meta-pixel.ts`: `installPixel` / `removePixel` / `getPixelStatus`
    (idempotent install — removes existing pixel ScriptTags first).
  - `GET /api/pixel/script` (public): emits the pixel JS at request time from the
    env var (no-op when unset); fires PageView always plus ViewContent, AddToCart,
    and Purchase from guarded Shopify storefront globals. Pixel ID is validated
    `^[0-9]+$` before interpolation.
  - `/api/pixel/install`: GET status, POST install, DELETE uninstall; script src
    derived from the request origin; session-gated by `proxy.ts`.
  - Settings → Meta Pixel section: status, Install/Reinstall/Uninstall, env warning.
  - `proxy.ts` allowlists `/api/pixel/script` (Shopify fetches it without a session).
  - Caveat: ScriptTags don't run on the new Checkout Extensibility checkout, so
    Purchase tracking relies on the legacy order-status page.

## [0.5.5.0] - 2026-05-28

### Fixed
- **Hook deduplication — 7-day window.** The `content_template` generate route
  selected a hook but never recorded its use and passed an empty exclusion list,
  so the same hook resurfaced across drafts (both within the content path and via
  the product path, which judges eligibility by `used_count`/`last_used_at`). Now
  excludes hooks seeded in the last 7 days (`getRecentlyUsedHookIds`, with a
  fallback to the full pool when the window exhausts the compatible set) and
  records usage after the draft is created. Recording is best-effort so a
  bookkeeping failure can't turn a created draft into a 500 + retry duplicate.

### Added
- **Clickbait system prompts + 6 new templates.** Added per-language system
  prompts to the content generate call (none existed): FR opens on a shock
  question / surprising stat and always closes on an open comment-inviting
  question; EN uses a surprising question / counterintuitive statement. Templates
  with an exact hook/closer keep precedence. Added 6 fully-bilingual clickbait
  templates (`clickbait_erreur_meubles`, `clickbait_canape_personnalite`,
  `clickbait_regle_design_pros`, `clickbait_salon_desordre`,
  `clickbait_meuble_essentiel`, `clickbait_hot_take`), seeded via `INSERT OR
  IGNORE` so already-seeded production DBs pick them up.
- **Unsplash images on content_template drafts.** Each `content_template` draft
  is now illustrated with a themed Unsplash photo: the template theme (scopes +
  interpolated vars) maps to an Unsplash query, one landscape image is fetched,
  and `triggerDownload` is called per Unsplash API guidelines. Three new
  `facebook_drafts` columns (`unsplash_image_url`, `unsplash_photographer`,
  `unsplash_photographer_url`) store the image + attribution; the drafts preview
  shows a thumbnail and photographer credit. The image flows into the existing
  multi-photo publish path, ahead of the incidental product image. The fetch is
  best-effort — a failure never blocks draft creation.

## [0.5.4.0] - 2026-05-27

### Added
- **Draft scheduling UI** in `/drafts` dashboard. Each `draft` or `approved`
  draft now exposes a datetime-local input + "Planifier" button. Saving
  flips the draft to `status='scheduled'` with `scheduled_at` set; the
  existing `/api/cron/social-scheduled` cron (every 15 min,
  `processScheduledDrafts`) auto-publishes when the time arrives. Cancel
  reverts to `status='draft'` and clears the timestamp.
- New API endpoints `POST` and `DELETE` on `/api/social/drafts/:id/schedule`
  (session auth, admin only, reviewer role forbidden).
- `Planifié` and `Échec` options in the status filter; `Nouveau produit`
  in the trigger-type filter.

### Fixed
- **Badge contrast** on the drafts dashboard. Status pills moved to higher
  contrast palettes (amber/emerald/gray) and trigger badges (`Contenu`,
  `Produit`, `Nouveau produit`) now use color-coded pills instead of
  faded gray text. Added `publishing` and `failed` status badges to
  cover the full cron pipeline state machine.

### Notes — pipeline already in place
- `facebook_drafts.scheduled_at` column already existed (since v0.1.x).
- `processScheduledDrafts()` in `src/jobs/job4-social.ts` already polls
  for due `status='scheduled'` rows, claims them atomically via
  `claimFacebookDraft` (no double-post on parallel cron instances), and
  publishes through `publishDraftToChannels`. This PR adds only the UI +
  REST shim to feed that pipeline; no cron or schema migration needed.

## [0.5.3.0] - 2026-05-26

### Added
- **Weekly blog auto-cron** (`/api/cron/blog`) — generates 1 FR + 1 EN draft blog
  article every Tuesday 15:00 UTC (11h00 Montréal). Topic rotation by ISO week
  number across 10 FR + 10 EN evergreen topics (same index = paired theme).
  Each article includes 1 featured + 2 inline Unsplash images via the existing
  `/api/blog/generate` route.
- **Dual-auth on `/api/blog/generate`** — POST now accepts a `Bearer CRON_SECRET`
  header in addition to the existing session cookie, so the cron route can
  invoke it server-to-server. Timing-safe comparison.

### Configuration
- `vercel.json` cron entry: `{ path: /api/cron/blog, schedule: 0 15 * * 2 }`
- Function `maxDuration: 180` (two sequential generate calls + 3s spacing)

## [0.5.1.0] - 2026-05-18

### Fixed
- **Bilingual draft display**: EN content_template drafts now correctly stored in `post_text_en`
  (was incorrectly stored in `post_text` / "FRANÇAIS" zone of dashboard)
- Corrected existing EN drafts #329-331 data placement (`post_text → post_text_en`)
- Draft list preview now falls back to `postTextEn` when `postText` is empty (EN-only drafts)

### Changed
- **Disabled stock_highlight draft generation** temporarily — cron returns `skipped` response
  (waiting for image attachments feature; product posts need images to be effective on Facebook)
- **Disabled new_product draft generation** temporarily — import pipeline no longer triggers social draft
  (same reason; will re-enable when image attachments feature is built)
- content_template generation remains fully active (engagement/tips/polls work text-only)

## [0.5.0.0] - 2026-05-13

### Added

- **12 English prompts** for Furnish Direct content generation (`prompt_pattern_en` column)
  - 3 education: `conseil_deco_piece`, `guide_achat_categorie`, `astuces_entretien`
  - 4 inspiration: `inspiration_ambiance_maison`, `inspiration_vie_outdoor`, `inspiration_animaux`, `inspiration_famille`
  - 3 engagement: `sondage_debat`, `devine_quizz`, `aide_choisir`
  - 2 seasonal: `saisonnier_outdoor`, `saisonnier_indoor`
- **EN generation support** in `/api/social/content/generate`
  - `language: "en"` now accepted (was previously blocked with 400)
  - EN uses `prompt_pattern_en`, EN categories/months/seasons, `selectCompatibleHooks(..., "EN", [])`
  - Draft saved with `language: "en"` for correct downstream routing
- **Migration script** `src/scripts/migrate-en-prompts.ts` — parameterized UPDATEs, apostrophe-safe

### Architecture

- Reused existing `prompt_pattern_en` column (was `'TODO_EN'` placeholder in all 12 rows)
- No DB schema migration needed — 12 UPDATE statements only
- `selectCompatibleHooks` already supported `"EN"` language filter
- Brand bifurcation: Ameublo Direct (FR) vs Furnish Direct (EN)
- Audience: Canadian homeowners 25-45, `you/your`, seasonal Canadian milestones

### Tests

- Updated `language=en` test: was expecting 400, now expects 200 with EN vars
- Added 4 new tests: EN vars shape, EN hook selection, unsupported language 400, language default

## [0.4.3.0] - 2026-05-13

### Added

- **Language-selective publish** on `/drafts` dashboard for approved drafts
  - 3 separate publish buttons per draft based on available content:
    - `📢 Ameublo (FR)` — publishes FR caption to Ameublo only
    - `📢 Furnish (EN)` — publishes EN caption to Furnish Direct only
    - `📢 Les deux (FR + EN)` — publishes both (shown only when both captions exist)
  - Language-specific confirmation modals with distinct button colors (blue/indigo/purple)
  - `PublishLanguage = 'fr' | 'en' | 'both'` type exported from server action
  - `publishDraft(draftId, language)` extended with optional `language` param (default `'both'`)

### Not in this ship

- Schedule publish
- Auto-publish cron
- Bulk publish

## [0.4.2.0] - 2026-05-13

### Added

- **Publish Now button** on `/drafts` dashboard for approved drafts
  - Manual trigger only (confirmation modal required — action is irreversible)
  - FR posts → Ameublo Direct (page 1057151924144231)
  - EN posts → Furnish Direct (page 1080288908505354)
  - Bilingual drafts: publishes to both pages in parallel
  - Success / error / partial-failure feedback displayed inline
  - Failed publishes preserve `status='approved'` for retry
- `publish_error TEXT` column on `facebook_drafts` (idempotent `ALTER TABLE` in `ensureSchema`)
- 9 new tests for `publishDraft` server action (mocked `publishText`)
- Pre-existing TS fix: `scheduled-posts.test.ts` fixtures updated for `approvedAt/reviewedBy/reviewNotes`

### Reuses existing

- `facebook-client.ts` `publishText()` helper (audited before use)
- `social-publisher.ts` try/catch pattern
- `facebook_post_id` + `published_at` columns (already in schema)

### Not in this ship

- Image attachments (text-only MVP)
- Auto-publish cron
- Schedule publish (date picker)
- Bulk approve/publish

## [0.4.1.0] - 2026-05-12

### Added
- **Atomic lock for `runSyncFull()`** — prevents parallel executions
  - `src/lib/sync-lock.ts`: `tryAcquireSyncLock()`, `releaseSyncLock()`, `getSyncLockStatus()`
  - Atomic acquire via `db.batch([DELETE stale, INSERT OR IGNORE])` in a single Turso transaction
  - TTL 900s (> maxDuration 800s) — auto-releases on crash/SIGKILL without manual intervention
  - Holder auto-detected by UTC hour: `cron-06-00` / `cron-06-30` / `manual-{timestamp}`
  - Lock released in `finally` block — DB errors on release are caught and logged, never re-thrown (prevents swallowing the original sync error)

### Fixed
- Race condition discovered 12 mai: 4 `runSyncFull()` invocations in parallel → 4× `recordPriceChanges` → duplicate `sync_logs` entries
- Second parallel call now returns immediately: `{ skipped: true, reason: "Another sync in progress", lockHolder: "...", lockAgeSeconds: N }`
- Lock release errors in `finally` no longer replace the original error or turn a successful sync into a 500

### Protected use cases
- Vercel cron 06:00 still running + retry 06:30 starts → 06:30 skips cleanly
- Manual dashboard "Run" clicked multiple times rapidly → only first proceeds
- Crash mid-sync → TTL expires → next scheduled cron auto-recovers

## [0.4.0.0] - 2026-05-12

### Changed (ARCHITECTURE)

- **Plan B Chunked → Fluid Compute single function (Alt B)**
- New `runSyncFull()` séquentielle (init → chunks loop → finalize) in `src/jobs/job1-sync.ts`
- `/api/cron/sync` route now calls `runSyncFull()` with `maxDuration=800` (Vercel Pro Fluid Compute)
- 1 retry cron slot added at 06:30 UTC — idempotent via `Phase1Checkpoint`
- Eliminates Vercel cron missed-invocation fragility (root cause of 3 fails in 5 days)

### Removed (vercel.json crons only — routes kept as code for manual fallback)

- `/api/cron/sync-refresh` × 4 cron slots (06:20, 06:40, 07:00, 07:20)
- `/api/cron/sync-finalize` × 1 cron slot (07:40)
- `MAX_REFRESH_SLOTS` constant + guard (no longer pertinent with Fluid Compute)

### Architecture rationale

Root cause Bug C identified via investigation 12 mai:
Vercel docs: "If a cron invocation fails, Vercel does not retry it."
6 cron slots = 6 chances of fail → 3 fails in 5 days (8, 11, 12 mai).
Migration to 1 + 1 retry = drastically simpler and more robust.

### Fixed (pre-landing)

- Stale error message at `src/jobs/job1-sync.ts:277` still referenced "07:40 UTC" — updated to reflect 06:00/06:30 cron schedule
- `runSyncFull()` now throws if `runSyncFinalize()` returns `skipped=true` unexpectedly, preventing silent partial-sync

### Validation pending (reset 3/3 strict)

- 13 mai 06:00 UTC: 1/3 after architecture migration
- 14 mai 06:00 UTC: 2/3
- 15 mai 06:00 UTC: 3/3 → Bug C truly closed

### Next steps

- Alt C Inngest migration planned in 2 weeks (~8-12h) for full robustness

## [0.3.2.0] - 2026-05-11

### Fixed

- **Bug C infrastructure resilience** — diagnosed 11 mai 2/3 fail, shipped 2 targeted fixes
  - `BLOB_FETCH_TIMEOUT_MS`: `30s → 60s` in `sync-blob-storage.ts` — 19MB Phase 1 blob reads exceeded 30s on degraded Vercel Blob infrastructure (observed 06:00–08:00 UTC 11 mai)
  - Self-healing stale lock in `runSyncRefreshChunk` — calls `clearStaleLockIfNeeded(15)` before `createSyncRun`, clearing orphan 'running' records left by prior SIGKILL/timeout without waiting for 08:00 UTC Shopify sync
- **Root cause confirmed non-regression** — PRs #50/#51/#52 innocent; cause was transient Vercel Blob + Aosom CDN degradation
- **3 new tests** — timeout constant (60s), self-healing ordering, no-op when no checkpoint

### Validation pending (reset 3/3 strict)

- 12 mai 06:00 UTC: 1/3
- 13 mai 06:00 UTC: 2/3
- 14 mai 06:00 UTC: 3/3 → Bug C officially closed

## [0.3.0.0] - 2026-05-10

### Added

- **`/drafts` dashboard page** — master-detail review UI for Facebook drafts
  - Left panel: paginated list with status badge, trigger type, hook indicator (◆), 100-char FR preview, date
  - Right panel: full FR caption, EN caption (if present), review notes (if rejected), approve/reject actions
  - Filters: status (all/draft/approved/rejected/published), trigger type, hook (with/without/all)
  - Approve: one-click, disabled if already approved
  - Reject: requires non-empty reason text (inline textarea), disabled if already rejected
  - Pagination: prev/next with `hasMore` guard
- **`GET /api/drafts`** — paginated query endpoint; filters: `status` (comma-separated), `triggerType`, `hook`, `since`, `until`, `page`, `pageSize` (max 50)
- **Review columns on `facebook_drafts`** — idempotent `ALTER TABLE`: `approved_at INTEGER`, `reviewed_by TEXT`, `review_notes TEXT`
- **`getDraftsForReview()`**, **`approveDraftDb()`**, **`rejectDraftDb()`** — new DB functions
- **`approveDraft` / `rejectDraft` server actions** in `src/app/(dashboard)/drafts/actions.ts`
- **Sidebar** — "Drafts" nav item (clipboard icon) between Social Media and Settings; hidden from reviewer role
- **14 new tests** in `tests/drafts.test.ts` — GET /api/drafts (7) + approveDraft action (2) + rejectDraft action (3) + filter logic (2)

## [0.2.2.0] - 2026-05-10

### Added

- **`GET /api/cron/content`** — scheduled content generation cron, Mon/Wed/Fri at 14:00 UTC
  - Selects a random template weighted by `frequency_per_month`
  - Calls `/api/social/content/generate` internally with Bearer CRON_SECRET auth
  - Returns `{ success, template, contentType, draftId, hookId, triggeredAt }`
  - Returns 503 if no active templates, 500 if generation fails
- **`selectRandomTemplate()`** in `src/lib/content-template-selector.ts` — weighted random selection over active templates; `frequency_per_month=0` treated as weight 1 (never excluded)
- **`vercel.json`** — new cron slot `"0 14 * * 1,3,5"` (12 total, well under 40 limit)
- **10 new tests** — 4 for `selectRandomTemplate` (null/single/weighted/zero-freq) + 6 for the cron route (401×2/503/500/200/fetch-args)

## [0.2.1.0] - 2026-05-10

### Added

- **`POST /api/social/content/generate`** — new endpoint for on-demand content generation from a named template
  - Accepts `{ templateSlug, language }` (only `"fr"` supported)
  - Resolves template → interpolates dynamic vars (saison, mois, category, room) → calls Claude → saves FB draft
  - Returns `{ success, draftId, postText, templateSlug, hookId, vars }`
  - Auth: session cookie OR `Authorization: Bearer CRON_SECRET` (for cron integration)
  - `reviewer` role blocked (403)
  - Graceful errors: 404 template not found, 422 inactive template, 503 no products in catalog, 502 empty Claude response

- **`mode` field on `content_templates`** — distinguishes how each template opens its post
  - `hook_seeded` (3 templates): opening hook pulled from hook pool, injected as `{{hook}}` in prompt
  - `generative_seeded` (9 templates): Claude self-generates its own opening hook — no pool needed
  - Migration: idempotent (`!ctCols.has("mode")` guard), assigns mode to all 12 existing templates on first boot

- **Tutoiement constraint** — 6 inspiration/seasonal templates now enforce `Tutoiement OBLIGATOIRE (tu/te/ton)` in prompt, preventing vous/votre/vos in generated posts. Settings-gated migration (`tutoiement_v1_migrated`).

- **2 new test cases** in `content-templates.test.ts`: `mode hook_seeded calls selectCompatibleHooks and injects hookId` + `mode generative_seeded skips hook selection and saves with hookId=null`

### Changed

- `src/proxy.ts` PUBLIC_PATHS: added `/api/social/content` so Bearer-auth cron calls can reach the route handler without being redirected to `/login`
- `src/lib/database.ts` `ContentTemplate` interface: added `mode` field; both mappers (`getContentTemplates`, `getContentTemplateBySlug`) include mode
- `src/lib/seed/content-templates-megastore.ts`: all 12 templates have `mode`; 9 generative_seeded prompts self-generate hook instead of injecting `{{hook}}`
- `tests/content-templates.test.ts`: `{{hook}}` test is now mode-aware (hook_seeded must contain it; generative_seeded must NOT)

## [0.2.0.0] - 2026-05-09

### BREAKING — Architectural change (Bug C definitively closed)

**Phase 1 sync — monolith → 3-phase pipeline**

Root cause diagnosed 09 mai: `runSync({ shopifyPush: false })` exceeded Vercel `maxDuration=300s` when `fetchAll` was slow (~61s) because `refreshProducts` had no timeout guard and consumed the remaining budget (~239s). Vercel SIGKILL left runs as "running" in DB until stale lock clearer intervened.

Pattern: 3 out of 4 days (06, 07, 09 mai) failed; 08 mai succeeded only because `fetchAll` was unusually fast (29s), leaving 271s for `refreshProducts` (123s).

**New pipeline:**

| Cron | Time (UTC) | Function | Budget |
|---|---|---|---|
| `/api/cron/sync` | 06:00 | `runSyncInit()` — fetchAll + diff + save blob | 200s |
| `/api/cron/sync-refresh` | 06:20, 06:40, 07:00, 07:20 | `runSyncRefreshChunk()` — 2500 rows/chunk | 200s each |
| `/api/cron/sync-finalize` | 07:40 | `runSyncFinalize()` — rebuildCounts + recordPriceChanges + notify | 60s |

`REFRESH_CHUNK_SIZE = 2500`. Typical catalog: 1–3 chunks. Each chunk ~60s.

State is passed via `Phase1Checkpoint` stored in settings table (same pattern as `ShopifyPushCheckpoint`). `toWrite` + `priceChangeEntries` serialized to Vercel Blob between phases.

### Added

- `src/lib/sync-blob-storage.ts` — Vercel Blob helper (`savePhase1Blob`, `readPhase1Blob`, `deletePhase1Blob`) with SSRF guard, 30s timeout, JSON shape validation
- `Phase1Checkpoint` interface + `getPhase1Checkpoint()` + `savePhase1Checkpoint()` in `database.ts`
- `runSyncInit()`, `runSyncRefreshChunk()`, `runSyncFinalize()` in `job1-sync.ts`
- `src/app/api/cron/sync-refresh/route.ts` — new cron route (timing-safe auth)
- `src/app/api/cron/sync-finalize/route.ts` — new cron route (timing-safe auth)
- 40 new tests: 9 job1-sync phases, 16 cron route handlers, 15 blob storage unit tests
- `MAX_REFRESH_SLOTS = 4` guard in `runSyncInit` — throws if `totalChunks > 4` instead of silent pipeline abort
- Concurrent refresh protection — re-reads checkpoint after `refreshProducts` completes; skips save if another invocation already advanced it
- Error notification when `runSyncFinalize` skips due to incomplete refresh (was silent 200 OK)

### Changed

- `src/app/api/cron/sync/route.ts` — now calls `runSyncInit()`, `maxDuration` 300 → 200
- `src/app/api/cron/social/route.ts` — `maxDuration` 120 → 200 (Anthropic retry overhead fix)
- `vercel.json` — 4 new cron slots for sync-refresh (06:20/06:40/07:00/07:20) and sync-finalize (07:40); Phase 2 Shopify push moved to 08:00/08:15/08:30
- `PriceChangeEntry` interface exported from `job1-sync.ts`
- `runSync()` (manual trigger) now refuses to run while Phase 1 chunked pipeline is in progress
- `runSyncFinalize` saves checkpoint as finalized BEFORE deleting blob (prevents silent price history loss on retry)

### Validation pending

3 consecutive healthy Phase 1 completions required to close Bug C:
- 10 mai 06:00–07:40 UTC: 1/3
- 11 mai 06:00–07:40 UTC: 2/3
- 12 mai 06:00–07:40 UTC: 3/3 → Bug C CONFIRMED CLOSED

## [0.1.22.0] - 2026-05-08

### Added
- **Content templates — megastore foundation** — full replacement of 12 placeholder TODO templates with production-ready FR prompts
  - 4 content categories: `education` (3), `inspiration` (4), `engagement` (3), `seasonal` (2)
  - New slugs: `conseil_deco_piece`, `guide_achat_categorie`, `astuces_entretien`, `inspiration_ambiance_maison`, `inspiration_vie_outdoor`, `inspiration_animaux`, `inspiration_famille`, `sondage_debat`, `devine_quizz`, `aide_choisir`, `saisonnier_outdoor`, `saisonnier_indoor`
  - Each prompt: persona Ameublo Direct, tutoiement Québec, `{{hook}}` injection, concrete word/emoji/CTA constraints, example output
- **Schema migration** — 2 new columns on `content_templates`:
  - `frequency_per_month INTEGER NOT NULL DEFAULT 2` — publishing cadence (1–3/month)
  - `scopes TEXT NOT NULL DEFAULT '[]'` — JSON array of applicable product scopes (`mobilier_indoor`, `bedroom_decor`, `outdoor_patio`, `pets`, `kids_toys_sport`, `storage_kitchen`, `universal`)
- **TypeScript interfaces** — `ContentTemplate` interface + `getContentTemplates()` + `getContentTemplateBySlug()` exported from `database.ts`
- **Migration idempotency guard** — `conseil_deco_piece` slug check prevents re-running the DELETE+INSERT on subsequent cold starts (user edits survive)

### Migration notes
- One-shot: runs once on first cold start after deploy, then becomes a no-op
- Safe on prod: Turso columns pre-applied (2026-05-08), 12 templates seeded (IDs 6397–6408)
- EN prompts remain `TODO_EN` placeholder — scheduled for next session

### TODO (next session)
- Write 12 EN prompts (`prompt_pattern_en`) for Furnish Direct brand voice
- Implement `/api/social/content/generate` (Claude API call, replace 501 stub)
- Wire cron scheduling for non-product content

## [0.1.21.0] - 2026-05-08

### Added
- **Catalogue sort options** — 2 new sort options on `/catalog`:
  - **Best sellers (14d)**: products with most units sold in the last 14 days, ranked by `SUM(old_qty - new_qty)` from `stock_change` events in `price_history`. Products with no sales history rank last.
  - **Price drop %**: products with the largest price decrease in the last 14 days, ranked by `(MAX(old_price) - current_price) / MAX(old_price)` from `price_drop` events. Products with no price drop rank last.
- Products with no history in the last 14 days always rank last — so results stay meaningful even when half the catalogue has no recent activity
- Supports import curation: identify what's selling on Aosom (not yet imported) and products with active price drops to exploit

### Fixed
- **Best sellers sort accuracy**: excluded restock entries (`old_qty < new_qty`) from units-moved calculation — restocks would have inflated the negative contribution and pushed heavily-restocked products to the bottom
- **Price drop sort accuracy**: added `change_type = 'price_drop'` filter to exclude stock-change rows where `old_price > current_price` (incidental match, not an actual price drop event); added `old_price > 0` guard for division-by-zero safety

## [0.1.20.4] - 2026-05-08

### Fixed
- **Social cron auto-paused** since ~2026-05-01 due to Vercel 504 timeouts
  - Root cause: `getEligibleHighlightProduct` used `ORDER BY RANDOM()` on 10k+
    products — forces a full table scan on Turso = 60-82s
  - Combined with Anthropic API call (~5s), total exceeded Vercel 120s maxDuration
  - Vercel auto-pauses cron schedules after consecutive 504s
  - Fix: two-step pattern — `SELECT sku WHERE filters` (~4s) + JS random pick
    (instant) + `SELECT * WHERE sku = ?` (<1s). Total: <10s vs 60-82s.
- **Sync-race guard** — step-2 query now re-validates `shopify_product_id IS NOT NULL
  AND qty > 0` to prevent drafts being generated for products that became OOS between
  the two queries (concurrent sync run scenario)

## [0.1.20.3] - 2026-05-07

### Fixed
- **Dashboard Trending Products** — "undefined/day" and "undefined left" displayed
  - `TopSeller` interface expected `soldPerDay`, `currentQty`, `daysTracked`
  - API was returning only `unitsMoved` — 3 fields rendered as undefined
  - Fix: `database.ts` adds `p.qty AS current_qty` to SELECT; `route.ts` computes
    `soldPerDay` (units_moved / 14), `currentQty`, `daysTracked: 14` server-side

### Changed
- Cleaned `TopSeller` interface — removed unused `color` and `productType` fields

## [0.1.20.2] - 2026-05-07

### Fixed
- **Bug C step 3** — Brand extraction inconsistency causing ~7,500 false positive description diffs daily
  - Root cause: `csv-fetcher.ts` `extractBrand()` returned the first word of the product name
    for unknown brands (e.g., `"Commercial"`, `"10x13ft"`, `"Cosmetic"`), but the DB stored
    `"Aosom"` for these same 9,700/10,731 products (91%)
  - Daily mismatch inflated `toWrite` to ~9,000 products (vs ~2,500 real changes),
    causing `refreshProducts` to take 204s and Phase 1 to exceed the Vercel 300s timeout
  - Fix: unknown brands now always return `"Aosom"`, aligned with DB historical data
  - Known brands (Outsunny, HomCom, PawHut…) are NOT affected
  - Math: `toWrite` ~9,000 → ~2,500, `refreshProducts` 204s → ~81s, Phase 1 ~204s → ~140s
- **Bonus** — Exclude `out_of_stock_expected` from `hasChanged()` diff
  - Field contains `"Low Stock Alert"` string (not date-based), only 204/10,731 products (1.9%)
  - Not used business-side (Shopify display). Safe to exclude (same rationale as BUG-C-STEP2)
  - Field still written during upsert when a product changes for another reason

### Tests
- Updated Test 8 in `product-diff.test.ts` — OOS-only change now yields `unchanged` (not `toUpdate`)
- Added Test 8b — OOS + price change still triggers `toUpdate` (price wins)
- Added 2 tests in `csv-fetcher.test.ts` — unknown brand fallback → `"Aosom"`, known brands preserved

## [0.1.20.1] - 2026-05-04

### Fixed
- **Bug C step 2** — Exclude `estimated_arrival` from `hasChanged()` in `product-diff.ts`
  - Aosom advances `Estimated Arrival Time` by 1 day daily for ~2,197 in-stock products
  - This inflated `toUpdate` to ~5,000 products/day, causing `refreshProducts` to hit the
    Vercel 300s function limit (5 batches × 45s = 225s + 75s setup = 300s → killed)
  - Field is not used business-side (Shopify display); exclusion validated 2026-05-05
  - Products with genuine changes (price/qty/stock) still update their ETA in the same upsert
  - Expected impact: `toUpdate` ~5,000 → ~300/day, Phase 1 ~120s (180s margin)

## [0.1.20.0] - 2026-05-04

### Added
- **Hook pool rotation system** for FB/IG draft generation
  - 200 hooks seeded (100 FR + 100 EN, 5 categories × ~20 hooks/language)
  - 7 product scopes: universal, mobilier_indoor, outdoor_patio, pets,
    kids_toys_sport, storage_kitchen, bedroom_decor
  - Multi-tagging: 1 hook can cover multiple scopes (e.g. mobilier+bedroom)
  - Anti-repeat rotation: excludes last 5 *distinct* categories from selection
  - Mode 60% pool (verbatim hook) / 40% generative_seeded (spirit variation)
- DB tables: `content_hook_categories`, `content_hooks`, `hook_usage_history`
- `mapProductTypeToScope()`: 14 prefix rules → 7 scopes (home_office merged into mobilier_indoor)
- `selectHook()`: rotation + scope filter + mode split + 3-level fallback
- `seedHooksIfEmpty()`: lazy seeding with UNIQUE index + INSERT OR IGNORE (race-safe cold starts)

### Changed
- `generateBilingual()` integrates hook selection into prompt construction
- Graceful fallback: if `selectHook()` throws, generation continues without hook
- `facebook_drafts.hook_id` (FK nullable) tracks the hook used per draft

### Fixed
- False-advertising risk: 8 pool-mode hooks with specific stock counts and day-bound deadlines
  moved to generative_seeded mode (Quebec Consumer Protection Act compliance)
- `getRecentHookCategoryIds()` now uses DISTINCT to correctly exclude up to 5 distinct categories
- `selectCompatibleHooks()` uses parameterized LIKE patterns (SQL safety)
- Added "Home Decor" (ASCII) scope rule alongside "Home Décor" (Unicode)

## [0.1.19.0] - 2026-05-02

### Fixed
- **Bug B: UX published posts** — buttons remained clickable after publish,
  allowing accidental re-publish or edit of posts already on Facebook/Instagram
- Edit, Photos, Reject, Publish now disabled when status='published'
- Delete on published draft requires confirmation (warns about history loss;
  FB post stays online)
- Publish panel now closes when draft transitions to published mid-session
  (prevented potential double-post to Facebook via channel buttons)
- Detail-area "Publié le" badge now guarded by isPublished() — was showing
  for any draft with publishedAt set regardless of status
- `publishedAt` guards use `!== null` instead of falsy check — epoch timestamp
  (0) no longer silently hides the badge

### Added
- "· Publié le {date}" badge in draft card header (visible at glance)
- Helpers: isPublished(), formatPublishedAt() with fr-CA locale

### Changed
- `formatPublishedAt` uses `toLocaleString` (ECMA-402 compliant) instead of
  `toLocaleDateString` with time options (non-standard mixing of date+time opts)
- Existing publishedAt timestamp now uses fr-CA format (was browser-dependent)
- 14 new unit tests (logic helpers, 199/199 total)

### Notes
- Tests written as pure logic units (no @testing-library/react in project)
- Asymmetric layout on rejected drafts: backlog P3

## [0.1.18.3] - 2026-05-02 (perf)

### Changed
- **Pin Vercel functions to `yul1` (Montréal)** — co-locate with Blob store
- Before: functions ran in `iad1` (US East), blob in `yul1` → 30s cross-region body read
- After: `yul1::yul1` → blob fetch ~1-2s, Aosom CDN download 9.5s → 2.3s (4×)
- fetchAll still dominated by Shopify API pagination (~70-99s), but blob no longer a risk

## [0.1.18.2] - 2026-05-02 (hotfix)

### Fixed
- **Blob fetch timeout still too short** — `BLOB_FETCH_TIMEOUT_MS` 30s → 60s
- Empirical 02 mai: 30s timeout also triggers live CDN fallback (fetchAll 81.9s)
- Root cause: `AbortSignal.timeout()` covers full body read; 45MB at ~1.5 MB/s
  (Vercel function ↔ Blob throughput) = ~30s body read alone; 60s provides 2× margin

## [0.1.18.1] - 2026-05-02 (hotfix)

### Fixed
- **Blob fetch timeout too aggressive** — `BLOB_FETCH_TIMEOUT_MS` 10s → 30s
- Empirical post-deploy: Vercel function ↔ Blob throughput ~4-5 MB/s on 45MB CSV,
  typical fetch ~10s, causing 10s timeout to trigger live CDN fallback on every Phase 1
- Fix restores the pre-cache benefit: Phase 1 fetchAll expected <30s instead of ~95s

## [0.1.18.0] - 2026-05-02

### Fixed (Bug C definitive)
- **Phase 1 cron timeout 80% of nights** — pre-cache CSV in Vercel Blob
  decouples Aosom CDN download from sync execution

### Added
- Table `csv_blob_cache` (single row) with blob URL + metadata
- DB functions: getCachedBlobUrl, upsertBlobCache, isCacheStale (12h max age)
- `/api/cron/csv-precache` endpoint (Bearer auth, maxDuration 600)
- 4 cron schedules: 04:00 UTC primary, 05:30 backup, 12:00, 18:00
- 13 new tests (3 DB, 5 endpoint, 4 fetcher fallback, 1 stale logic)

### Changed
- `fetchAosomCatalog` uses fallback chain: blob_cache → live_fallback
- csv_source logged: 'blob_cache' or 'live_fallback' for observability
- Empirical: blob fetch 1.22s avg (vs 27-199s Aosom CDN)

### Notes
- Blob access: 'public' (URL random hash, content already public via CDN)
- import-pipeline.ts unchanged (uses live fetch, no Vercel 300s constraint)
- Bench data preserved in commit message for future reference

## [0.1.16.2] - 2026-04-27

### Changed — Observability: Phase 1 timing complet

- Instruments `applyToShopify` + `addSyncLogsBatch` + `createNotification` avec `timing_ms` pour couvrir le gap non instrumenté identifié post-PR #36.
- Aucun changement de logique. Les nouvelles clés `applyToShopify`, `addSyncLogsBatch`, `createNotification` apparaissent dans `timingMs` des sync_runs.

## [0.1.16.1] - 2026-04-26

### Changed — refreshProducts batch size 100 → 1000

- `refreshProducts()` now upserts catalog rows in batches of 1000 instead of 100, reducing the number of Turso HTTP round-trips for a 10k-product catalog from ~103 calls to ~11. Empirical bench (25 avril, 2000 rows): batch_size=1000 totals 82s vs 330s at 100 — a 4× end-to-end speedup driven by Turso's internal SQLite transaction grouping.
- Sibling batch loops in `recordPriceChanges()` and `addSyncLogsBatch()` remain at 100 (small datasets, not the bottleneck).
- Documents the Turso 8MB HTTP API cap: at ~427KB/100 rows, 1000 rows ≈ 4.27MB — within limit.
- New test: 1500 products → asserts exactly 2 batches (1000 + 500). 170 tests total.

## [0.1.16.0] - 2026-04-25

### Added — Non-product content template infrastructure

- New `content_templates` table (slug, content_type, FR/EN prompts, image_strategy, active flag) with indexes on slug and type.
- New `content_generation_log` table for audit trail (template_slug, draft_id, language, success/error).
- `content_type` column on `facebook_drafts` (DEFAULT `'product'`) to distinguish product posts from non-product content.
- Seed of 12 content templates across 3 categories: informative ×4 (seasonal_tip, mistake_listicle, myth_vs_reality, product_comparison), entertaining ×4 (relatable_meme, pov_scenario, nostalgic_throwback, design_quote), engagement ×4 (this_or_that, guess_the_price, caption_this, unpopular_opinion). Prompts marked TODO for creative session.
- `POST /api/social/content/generate` — admin-only stub returning 501 with input echo. Validates `language` (required: fr|en) and `content_type` (optional: informative|entertaining|engagement).
- `POST /api/social/content/generate-weekly-mix` — admin-only stub returning 501. Validates `language` (required).
- 6 new tests: migration idempotency, seed count/idempotency, route 501 and 400 responses. 169 total.

## [0.1.15.1] - 2026-04-25

### Fixed — Non-atomic scheduled draft claim (double-post risk)

- Adds `claimFacebookDraft(id)` in `database.ts`: executes `UPDATE facebook_drafts SET status='publishing' WHERE id=? AND status='scheduled'` and returns `rowsAffected === 1`. If two Vercel cron instances race on the same draft, only one UPDATE matches — the other gets `false` and skips publication.
- `processScheduledDrafts` now uses `claimFacebookDraft` instead of unconditional `updateFacebookDraft(..., {status:'publishing'})`. Drafts that fail to claim are skipped (counted in `processed` but not in `success` or `failed`).
- Previous code used `UPDATE ... WHERE id=?` (no status guard) — both concurrent instances would succeed and both would call `publishDraftToChannels`. Eliminated.
- Replaces 1 mock-weak concurrent test with 3 assertion-strong tests: claim-returns-false skips publish, claim called once per due draft, partial-claim counts correctly.
- 163 tests total (+2 net: 1 replaced by 3).

## [0.1.15.0] - 2026-04-25

### Fixed — Scheduled posts never published

- Adds `processScheduledDrafts()` in `job4-social.ts`: claims drafts via `status='publishing'` (idempotent), reads `social_autopost_channels` setting for target channels, calls `publishDraftToChannels()` (existing shared path), and marks `status='failed'` if all channels fail.
- Adds `/api/cron/social-scheduled` route: GET handler (Vercel cron, Bearer CRON_SECRET) + POST handler (manual trigger, session auth).
- Adds Vercel cron schedule `0,15,30,45 * * * *` (every 15 min) in `vercel.json`.
- No DB schema migration required — existing `scheduled_at`, `channels`, and `status` columns support the workflow.
- `verifyCronSecret` now catches missing `CRON_SECRET` env var and returns `false` (401) instead of throwing (500).
- 14 new tests (161 total), covering route 401/500 paths, empty-channels branch, per-draft error catch, and partial channel success.

## [0.1.14.3] - 2026-04-25

### Fixed — CSV body stream timeout

- `fetchAosomCatalog()` now uses a single 240s `AbortController` timeout covering both the initial connection AND the full body stream download. Previously the timer was `clearTimeout`-ed before `response.text()`, leaving body streaming completely unprotected — on the Aosom nightly CDN slow window this caused Vercel SIGKILL at 300s.
- Removed retry logic: a 240s timeout × 2 retries + backoffs would exceed Vercel's 300s function budget. The daily cron serves as the natural retry.
- On timeout: throws `"CSV fetch exceeded 240s — likely Aosom CDN slow window"` — sync_run is marked `failed` with this message in `errorMessages` instead of dying silently via SIGKILL.
- On HTTP 5xx or network error: throws immediately (single attempt), error propagates cleanly to sync_run.

## [0.1.14.2] - 2026-04-25

### Added — Persistent timing diagnostics

- `sync_runs` table gains a `timing_ms` TEXT column (JSON map of phase → duration in ms). Written incrementally after each of 9 phases so a Vercel SIGKILL mid-run leaves the completed phases queryable via `/api/sync/history`.
- `updateSyncRunTiming(id, timing)` — new DB helper, non-throwing so timing writes never mask or interrupt the real sync error.
- `SyncRun.timingMs?: Record<string, number>` field exposed in the type and `mapSyncRun` (guarded JSON.parse, returns `undefined` on malformed DB value).
- Vercel log streaming proved unreliable for long-running functions (phases 4-10 never appear); DB writes are the only approach that survives SIGKILL.

### Fixed

- `JSON.parse(row.timing_ms)` in `mapSyncRun` now wrapped in safe IIFE — malformed DB value no longer crashes the sync history API.
- `updateSyncRunTiming` in the catch block no longer risks masking the original error (the function itself swallows its own failures with `console.warn`).

## [0.1.14.1] - 2026-04-25

### Added — Observability

- `runSync()` now emits structured JSON timing logs at each phase: `clearStaleLock`, `getLatestSyncRun`, `createSyncRun`, `fetchAll`, `diff`, `detectChanges`, `refreshProducts`, `rebuildProductTypeCounts`, `recordPriceChanges`, `completeSyncRun`.
- Each log line includes `phase` and `duration_ms` fields, plus phase-specific counters (`csv_count`, `snapshot_count`, `shopify_count`, `to_insert`, `to_update`, `unchanged`, `removed`, `rows_written`, `entries`, etc.).
- A `t0Total` wall-clock timer logs total `duration_ms` in both the success path and the catch block — so if Vercel kills the function before completion, the last log still shows elapsed time.
- `recordPriceChanges` phase now always logs (was silent when `entries=0`, creating a gap in the timeline).
- Zero logic changes — pure instrumentation to diagnose the Phase 1 timeout (prod times out at 300s, root cause unknown without timing proof).

## [0.1.14.0] - 2026-04-24

### Changed — Phase 1 sync performance (Bug C fix)

**Root cause:** Phase 1 nightly cron timed out every night because `refreshProducts()` UPSERTed all 10 426 products at ~250ms/row (Turso structural write latency) = ~2600s, well above the 300s Vercel limit.

**Fix: diff-before-upsert (Option α)**
- `runSync()` now fetches the CSV and a lightweight DB snapshot in parallel (`Promise.all`)
- `diffProductsLight()` classifies the 10k rows in O(n): new / modified / unchanged / removed
- `refreshProducts()` is called only for rows that actually changed (typically 100–300 per day, ~25–75s)
- `rebuildProductTypeCounts()` now uses `db.batch()` (1 round-trip vs 307 sequential `db.execute()` calls = ~77s saved)
- `detectChanges()` reuses the snapshot instead of issuing a separate `SELECT *` (8.8s warm removed from critical path)

**Expected Phase 1 budget:** ~1.6s snapshot read + ~3-5s CSV fetch (parallel) + ~25-75s writes = **~30-80s total**, well under 300s.

### Added
- `src/lib/database.ts` — `getProductsSnapshot()`: 13-col lightweight SELECT (~1.6s warm on 10k rows). Exported `ProductSnapshot` interface.
- `src/lib/product-diff.ts` — `diffProductsLight()`: pure O(n) diff function, no DB calls. Exported `ProductDiffResult` type.

### For contributors
- 137 tests (up from 120). New coverage: `getProductsSnapshot` SQL shape (2), `rebuildProductTypeCounts` batch correctness (2), `diffProductsLight` full matrix (11), `runSync` diff-before-upsert invariants (2).

## [0.1.13.0] - 2026-04-23

### Added
- `scripts/force-push-shopify.ts` — one-shot Shopify price drift recovery script. Reads all imported products from Turso, fetches the live Shopify catalog, computes price diffs (0.01 tolerance), and pushes corrections one variant at a time. Dry-run by default; requires `--apply` to write. Idempotent, re-runnable. Rate-limited at 100ms between Shopify calls.
- Writes a timestamped JSON audit report to `scripts/reports/force-push-<timestamp>.json` (gitignored) on both dry-run and apply.

### Fixed
- `loadImportedProducts()` now filters out products with NULL or zero prices before diffing, preventing an accidental `$0` push to Shopify.
- `validateEnv()` fails fast with a clear message if `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, or `SHOPIFY_ACCESS_TOKEN` are missing, rather than producing cryptic downstream errors.

### For contributors
- 120 tests (up from 119). Test suite covers all exported functions: `computePriceDiffs` (missing product, missing variant, price match, price diff, tolerance boundary), `applyPriceDiffs` (success, Error throw, non-Error throw, default/custom delay, partial failure), and `writeReport` (filename, JSON structure). Non-exported `main()` and helpers tested at integration level via the dry-run flow.

## [0.1.12.0] - 2026-04-22

### Fixed
- Social cron no longer silently produces zero drafts when the Anthropic API hangs. Each call now has a 45-second hard timeout via `AbortSignal.timeout()`. On timeout, the cron retries once after a 5-second pause. Worst-case wall time is 95 seconds, well under the Vercel 120-second function limit.
- Retry logic now correctly detects Anthropic SDK abort errors using `instanceof APIUserAbortError` instead of a `.name` string check. The string check (`name === "TimeoutError"`) was dead code — the SDK wraps signal aborts into `APIUserAbortError` (whose `.name` is `"Error"`).

### Added
- Structured logging in Job 4: `anthropic call started` (info, includes estimated token count), `anthropic call completed` (info, includes duration), `anthropic timeout, retrying` (warn), `anthropic failed after retry` (error). Makes future Vercel log triage instant.

### For contributors
- Tests for `triggerStockHighlight` now cover the full timeout + retry matrix: happy path, timeout-then-retry-succeeds, double timeout throws, non-timeout API error (429) bypasses retry.

## [0.1.11.0] - 2026-04-22

### Fixed
- `runShopifyPush()`: `createSyncRun()` now called **before** `fetchAllShopifyProducts()`. Previously the Shopify catalog fetch (~40 pages, >300s) ran before the DB row was inserted, so Vercel SIGKILL left no trace. The run is now visible in DB from the first millisecond, surviving any timeout.
- `runShopifyPush()`: `remaining.length === 0` path now calls `completeSyncRun(status="completed")` before returning, so the run record is properly closed rather than left in `status="running"`.
- `runSync({ shopifyPush: false })`: `fetchAllShopifyProducts()` is now skipped when `shopifyPush=false` (Phase 1 cron). Previously the full Shopify catalog was fetched even though its result was unused in the DB-only path, causing Phase 1 to timeout and create zombie runs.

### For contributors
- Updated Scenario 9: `runShopifyPush — all diffs already processed` now asserts `createSyncRun` IS called and `completeSyncRun(status="completed")` is called with `"Phase 2: no diffs remaining (checkpoint complete)"`.
- Added Test A: `runSync({ shopifyPush: false })` does not call `fetchAllShopifyProducts`.
- Added Test B: `runShopifyPush()` with a failing fetch still has `createSyncRun` in DB and `completeSyncRun(failed)` called (SIGKILL-safe invariant).
- Added Test C: `runShopifyPush()` with `cp.done=true` does not call `createSyncRun` (fast-path guard).
- Added positive-path test: `runSync({ shopifyPush: true })` calls `fetchAllShopifyProducts` (pairs with Test A). Total: 104 tests.

## [0.1.10.0] - 2026-04-19

### Fixed
- Vercel 300s timeout leaving zombie sync runs: cron now runs two phases. Phase 1 (`6:00 UTC`) does the DB sync only (CSV fetch, product upsert, price history). Phase 2 (`6:10`, `6:25`, `6:40 UTC`) reads from DB (no CSV re-fetch), computes diffs, and applies Shopify mutations in chunks of 10 with a persistent checkpoint so multiple cron fires can resume where the previous one left off.
- Stale-product archive regression: `getAllProductsAsAosom` now filters by `last_seen_at >= strftime('%s', date('now'))` (today's Unix timestamp) instead of `IS NOT NULL`, correctly identifying products not present in today's CSV as stale.
- Aborted Shopify fetch requests now produce a clear `"Shopify request timeout after 25s"` error instead of a generic `AbortError`.

### Added
- `GET /api/sync/health` — session-protected monitoring endpoint returning Phase 1 run status, Phase 2 checkpoint progress (`processedDiffs`, `totalDiffs`, `done`), zombie runs (stuck at `status=running`), and 5 most recent sync runs.
- `ShopifyPushCheckpoint` stored in `settings` table (`checkpoint_data` column). Survives Vercel SIGKILL so Phase 2 can resume across cron fires.
- `clearStaleLockIfNeeded(thresholdMinutes)` now accepts a configurable threshold (15 min for Phase 2 cron windows, 30 min for Phase 1).
- `SHOPIFY_MAX_RETRY_AFTER_S = 30` cap on Shopify 429 Retry-After headers.
- Structured JSON logging on `job1-sync` (replaces human-readable format).
- 10 new tests: `shopifyFetch` AbortError path, 429 single retry, 429 max retries, Retry-After cap at 30s; `runSync` dryRun mode; `runShopifyPush` catch block, remaining=0 short-circuit, completion notification. Total: 92 tests.

## [0.1.9.3] - 2026-04-19

### Changed
- Test runner: `bun run test:watch` and `bun run test:ci` scripts added to package.json for watch mode and verbose CI output. `bun run test` remains the correct command — `bun test` (bun's internal runner) silently skips tests that use `vi.stubGlobal` and is not supported.
- CLAUDE.md: added Testing section documenting the bun test vs bun run test distinction to prevent future test runner confusion.

## [0.1.9.2] - 2026-04-18

### Security
- Removed `/api/sync` from `PUBLIC_PATHS` in middleware. `POST /api/sync/trigger` and `GET /api/sync/history` were reachable without authentication — any anonymous user could trigger a live Shopify write sync. Both routes now require a valid session token (middleware-enforced).
- Upgraded Next.js from 16.2.1 to 16.2.4 to patch DoS vulnerability (GHSA-q4gf-8mx6-v5v3, CVSS 7.5) in Server Components request handling.

## [0.1.9.1] - 2026-04-18

### Security
- Reviewer role can no longer publish social posts (`POST /api/social` with action `publish` or `publish-multi` now returns 403 for reviewer sessions). Previously the proxy allowlist let the request through and the action ran unchecked.
- Reviewer role can no longer mutate settings (`PUT /api/settings` now returns 403 for reviewer sessions). GET still works — reviewer needs to view settings to verify the publishing workflow.
- Removed hardcoded HMAC_SECRET fallback in `auth.ts`. `hmacSign` now throws if `AUTH_PASSWORD` env var is missing, preventing silent token signing with an empty secret in misconfigured deployments.
- `ensureSeededUsers()` failure in auth route is now caught and logged as non-fatal, preventing a DB bootstrapping error from blocking all logins.

### Fixed
- Bilingual content migration script (`scripts/fix-bilingual-content.js`): caps Shopify Retry-After header to 30s max to avoid indefinite stalls on malformed rate-limit responses.

### Added
- 17 regression tests (`tests/auth-rbac.test.ts`) covering: 4-part token round-trips (admin, reviewer, colon-username), old 3-part token rejection, tampered payload rejection, invalid role rejection, garbage input, and `isPathAllowedForRole` prefix exactness for all reviewer-allowed and reviewer-blocked paths. Total: 65 tests.

### Changed
- `DbUserRole` in `database.ts` now derives from `UserRole` in `config.ts` (single source of truth). `SidebarRole` local type in `sidebar.tsx` removed in favour of shared `UserRole`.

## [0.1.9.0] - 2026-04-15

### Added
- Meta App Review preparation: everything needed to move the Facebook app from Development to Live mode. New public `/privacy` page (FR + EN, white clean theme) accessible without authentication so Meta reviewers can visit it. Role-based access control with a `reviewer` role restricted to Social Media and Settings pages only — proxy enforces the allowlist at middleware level and returns 403 for blocked API routes. Dedicated `meta-review` user auto-seeded from `META_REVIEW_PASSWORD` env var, revocable after approval.
- App icon generator script (`scripts/generate-app-icon.js`) produces 1024x1024 and 512x512 PNG icons via sharp SVG rasterization — blue gradient with "AS" monogram.
- Complete submission documentation (`docs/meta-app-review-submission.md`): permission descriptions for `pages_manage_posts` and `pages_read_engagement`, test credentials template, 6-scene screencast script, and step-by-step checklist covering Business Verification through post-approval cleanup.

### Changed
- Session tokens now encode the user's role (`ts:role:username:sig` format). Existing sessions force a re-login — no security impact, just a one-time redirect.
- `users` table gains a `role` column (`admin` | `reviewer`) via idempotent migration. Existing users default to `admin`.
- Sidebar filters navigation items by role — reviewer sees only Social Media and Settings.
- Public paths tightened from loose `startsWith` to exact-match + prefix check, fixing a latent bug where `/loginfoo` or `/api/authorize` would have bypassed auth.

## [0.1.8.1] - 2026-04-14

### Added
- Curated mass-import tooling: two new standalone scripts under `scripts/` that together turn a one-click flow into "pick 240 products across 8 categories, smoke test a handful, then push the rest." `curate-import-batch.js` reads the Aosom catalogue from Turso, applies category filters + a pricing/image-quality scoring pass, groups variant SKUs by parent, and writes a dated batch JSON + a markdown report under `data/curation/`. `mass-import-from-batch.ts` reads that batch and drives every listing through the existing import pipeline (content generation → Shopify draft → dual collection assignment → multi-photo social draft), with dry-run by default, `--execute` gate, `--limit=N` and `--spread` for progressive smoke tests, and `--resume` that queries Shopify directly to skip already-imported products. 2s delay between jobs, 5-consecutive-failure abort, JSONL checkpoint log. Proven at scale this release cycle: 226 new draft products landed on Shopify across the smoke + mass runs, only 2 data-level failures (variant collision and one Claude parse error).

## [0.1.8.0] - 2026-04-13

### Added
- Social media drafts now post between 1 and 5 photos per publication instead of a single image every time. Each generated draft picks a random count and shuffles the order from the product's 7 available images, so the Facebook feed no longer looks robotic. New hero + thumbnail row preview on `/social` draft cards, plus a "Photos" action that opens an inline editor to remove or reorder images before publishing.
- Facebook publishing handles multi-photo posts as proper albums: each photo is uploaded unpublished, then one `/feed` post is created with `attached_media` as a native JSON array. Single-photo posts continue to use the existing one-shot path with zero behavior change. Partial upload failures publish the album with whatever succeeded (all-failures throws loudly).
- `PATCH /api/social` accepts an `imageUrls` array on the `update` action so reordering and removing photos from the UI round-trips cleanly through Turso.
- 10 new unit tests covering `pickRandomImages` shuffle/cap behavior and the Facebook Graph API multi-photo payload shape (fetch-mocked — locks in the `attached_media` array format and per-brand Page ID routing). Total test count: 38 → 48.

### Changed
- `facebook_drafts` table gains an `image_urls` TEXT column (JSON array). Idempotent migration backfills legacy single-image drafts from `image_url` on first read. Legacy `image_url` column stays in sync with `imageUrls[0]` so older readers keep rendering thumbnails.
- Instagram publishing still uses only the primary image for now (IG carousel support is a follow-up — logged in `social-publisher.ts`).

## [0.1.7.0] - 2026-04-12

### Added
- Dual collection assignment: every newly imported product is automatically assigned to BOTH its main (broad Aosom category) and sub (specific sub-category) Shopify collection. Shoppers can now browse the store via either a high-level category like "Mobiliers extérieurs et jardins" or a narrower one like "Gazébos et abris extérieurs" and find the same product in both places.
- Three A1a super-main mappings seeded for the largest Aosom categories: "Patio & Garden" → Mobiliers extérieurs et jardins, "Home Furnishings" → Meubles et décorations, "Pet Supplies" → Accessoires pour animaux. Covers 83% of the catalogue (8,568 products).
- `scripts/audit-dual-collections.js` read-only audit tool for ongoing collection health checks.
- `scripts/migrate-collection-mappings-schema.js` idempotent schema migration for the dual-role collection mapping layout.
- `scripts/dry-run-dual-assignment.js` recovers products stuck in only one collection by adding the missing counterpart. Dry-run by default, `--execute` to apply, 422 "already linked" handled as an idempotent skip.

### Changed
- `collection_mappings` table gains a `collection_role` column (`main` | `sub`) with a composite primary key, replacing the old one-row-per-category layout. `/collections` UI continues to work unchanged (one-dropdown-per-category) — the backend now infers the correct role from the key format so saving never pollutes the schema.
- Import pipeline logs per-role assignment success separately (`[IMPORT] Added to [main] ...`, `[IMPORT] Added to [sub] ...`) and warns loudly when a product ends up not dual-assigned, distinguishing "missing mapping" from "POST failed" so partial failures are visible in logs.
- Import pipeline deduplicates when main and sub mappings target the same Shopify collection (e.g., Toys & Games both → "Jouets pour enfants"), avoiding the spurious 422 "already exists" that used to appear in logs.

### Migration
- 48 existing products that were in only one collection have been dual-assigned via the recovery script. Store now has 132 products correctly in main+sub, 3 test products in one collection (expected), 19 products in main+sub+marketing (Collection de printemps overlay, unchanged).

## [0.1.6.1] - 2026-04-12

### Added
- Three standalone Shopify forensic scripts in `scripts/`: `diagnose-shopify.js` audits collections/orphans/publish-state/templates, `compare-csvs.js` diffs a pair of product export CSVs to surface what changed, and `restore-shopify.js` republishes products that lost their published state (dry-run by default, `--execute` to apply, 500ms rate limiting, idempotent).
- Used together to recover from an incident where an Excel-saved CSV reimport flipped the Published column on 104 products and emptied the featured-collection sections on the homepage. All 150 active products are back online.

### Changed
- `.gitignore` excludes `data/shopify-backup/` so raw product CSVs never land in the repo.

### Docs
- TODOS.md adds a full spec for `feature/social-branded-images` (canvas-based template engine for new-product / price-drop / stock-highlight posts, brand identity config, integration points, Vercel serverless constraints).

## [0.1.6.0] - 2026-04-12

### Added
- Mobile responsive layout across every page. The sidebar nav collapses into a hamburger drawer below 768px with a fixed top header, slide-in animation, and a tappable backdrop to dismiss. Every dashboard page (Catalogue, Social, Import, Collections, Settings, Sync History, Dashboard) now stacks cleanly at 375px with no horizontal scroll. The product catalogue swaps its wide table for tappable product cards on mobile and keeps the full table on desktop. Stat rows, filter bars, and action buttons restack to full-width where it makes sense.

### Changed
- `NotificationBell` now mounts in exactly one place depending on viewport (mobile header on phones, sidebar on desktop) instead of rendering twice and double-polling `/api/notifications` every 30 seconds.

### Fixed
- Removed a `setState`-in-effect anti-pattern in the sidebar that tripped the React lint rule, and hoisted `fetchNotifications` behind `useCallback` so it is declared before the effect that uses it.

## [0.1.5.2] - 2026-04-11

### Fixed
- Publishing a social draft to Facebook no longer returns "Internal server error". The old code wrote the composed image to `/tmp/social-images/*.jpg` during draft generation and tried to read it back from disk at publish time, but Vercel serverless `/tmp` is per-instance and ephemeral. The publish request hit a different instance, the file was missing, and the upload crashed. The fix: hand Facebook a public image URL (same mechanism already used for Instagram) and let Meta fetch the image server-side. No more disk reads on the publish path.

## [0.1.5.1] - 2026-04-11

### Fixed
- Social Media drafts now show the product photo thumbnail instead of a broken image icon. Drafts generated on Vercel stored a `/tmp/...` filesystem path as the image source, which 404'd in the browser. The UI now skips those internal paths and falls back to the public Aosom CDN image URL.

## [0.1.5.0] - 2026-04-11

### Added
- Multi-brand social publishing: one click posts to Facebook Ameublo Direct (FR), Facebook Furnish Direct (EN), and Instagram Ameublo Direct (FR)
- Bilingual caption generation: every draft now stores both FR and EN captions, generated in parallel via Claude
- Per-channel publish state tracked in drafts (published / error / pending) with retry button per failed channel
- "Retry all failed" button on drafts with one or more channel errors
- New Instagram Graph API client (2-step media container + publish flow)
- Auto-post on price drop with configurable minimum drop %, daily limit, and channel selection (settings: social_autopost_enabled, social_autopost_min_drop_percent, social_autopost_max_per_day, social_autopost_channels)
- FR/EN preview tab on draft cards and dual-language editor
- New env vars: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_AMEUBLO_PAGE_ID/TOKEN, FACEBOOK_FURNISH_PAGE_ID/TOKEN, INSTAGRAM_AMEUBLO_ACCOUNT_ID

### Changed
- facebook-client.ts now takes a `brand` parameter ("ameublo" | "furnish") to resolve the correct Page ID + token
- facebook_drafts table: added `post_text_en` and `channels` columns (JSON per-channel state) via in-place migration
- /api/social publish action splits into legacy `publish` (single channel, back-compat) and new `publish-multi` (parallel fan-out)

### Notes
- Instagram Furnish Direct is not yet configured (account doesn't exist yet); the code path is ready and activates automatically when `INSTAGRAM_FURNISH_ACCOUNT_ID` is set
- Legacy `FACEBOOK_PAGE_ID` / `FACEBOOK_PAGE_ACCESS_TOKEN` env vars are kept as deprecated fallbacks for one release and will be removed in 0.1.6.0

## [0.1.4.1] - 2026-04-11

### Added
- Rate limiting on Claude API (30 calls/min) and Shopify push (60 calls/min) endpoints to prevent accidental cost spikes

## [0.1.4.0] - 2026-04-11

### Added
- Bulk generate: process all pending products to Shopify in one click with "Generate All Pending"
- Select individual products with checkboxes, then "Generate Selected" for partial batches
- Live progress bar with success/error counters and estimated time remaining
- "Stop" button to cancel a bulk operation mid-batch
- "Retry Failed" button to re-process only errored products
- Confirmation dialog before starting bulk operations
- 5th stat card showing error count

### Changed
- Import page now shows checkboxes for pending products and "Select all pending" toggle
- Status badges show "importing..." during Shopify push phase

## [0.1.3.0] - 2026-04-11

### Added
- Products are now automatically placed into the correct Shopify collection when imported, based on their Aosom category
- New /collections page to view and edit category-to-collection mappings with dropdown selectors
- "Sync Collections" button to assign existing Shopify products to their mapped collections in batch
- 35 pre-seeded mappings covering all 8 top-level Aosom categories (Patio, Home, Pets, Toys, Office, Sports, etc.)
- Hierarchical category matching: if "Patio > Furniture > Bistro Sets" has no exact mapping, it walks up to "Patio > Furniture" automatically
- Collections link added to the sidebar navigation

### Changed
- Collection sync uses in-memory mapping lookup instead of per-product DB queries (N+1 fix)

## [0.1.1.0] - 2026-04-06

### Changed
- Image composer now uses dynamic import for sharp, reducing cold start time on Vercel
- Social media images write to /tmp on Vercel (public/ is read-only in serverless)
- Facebook publish resolves image paths cross-environment via resolveImagePath()
- Sync engine loads all products in one query instead of one per CSV row (N+1 fix for 10k+ products)
- Stock change detection uses Set instead of Array.find() (O(1) vs O(n) per lookup)

## [0.1.0.0] - 2026-04-06

### Added
- Dashboard with sync overview, price drops, fastest selling, and recent sync runs
- Catalogue browser with 10k+ Aosom products, filters by category/price/stock/color, pagination
- Daily sync engine: fetch Aosom CSV feed, diff against Shopify, auto-apply price and stock changes
- Import pipeline: select products from catalogue, generate bilingual FR/EN content via Claude API, push to Shopify as drafts
- Social media pipeline: auto-generate Facebook post drafts for new products, price drops, and stock highlights
- Image composer: generate 1200x630 social media images with sharp (3 templates: new product, price drop, highlight)
- Facebook Graph API integration: publish posts with images, schedule posts, test connection
- Settings page: configure Facebook, social workflow, content, Claude prompts (with "Test Prompt" preview), image composer (color pickers, opacity slider, live preview), Shopify and Claude API connections
- SQLite database with better-sqlite3: products, price history, facebook drafts, settings
- Simple password auth with HMAC-SHA256 signed sessions (Web Crypto API, Edge-compatible)
- Vercel cron configuration for daily sync and social highlight generation

### Fixed
- Session token forgery vulnerability: switched from broken hash to HMAC-SHA256 with constant-time comparison
- Timing attacks on cron secret: replaced === with crypto.timingSafeEqual
- Facebook access token leak: moved from URL query param to Authorization header
- SVG escapeXml missing apostrophe: added &apos; for French product names
- Auth broken in Edge middleware: migrated from Node crypto to Web Crypto API
- Catalogue page crash on missing pagination data
