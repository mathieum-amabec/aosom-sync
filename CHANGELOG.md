# Changelog

All notable changes to Aosom Sync will be documented in this file.

## [0.5.53.112] - 2026-06-20

### Added (Ops tooling)
- **`scripts/sync-shopify-handles.mjs`** — one-shot maintenance script that resyncs
  `products.shopify_handle` (Turso) from the live Shopify product handles. Brand-cleanup
  renames on Shopify (stripping `-outsunny-`/`-aosom-` tokens) had left the DB column stale, so
  URLs built from it relied on a 301 redirect hop. Fetches every live handle via GraphQL
  (250/page), diffs against the DB, and `UPDATE`s the stale rows. Dry-run by default (writes a
  checkpoint), `--apply` replays the reviewed checkpoint with a drift guard
  (`WHERE shopify_handle = <old>`). Read-only against Shopify; the only write is to the DB.
  First run reconciled 458/638 stale handles.

## [0.5.53.111] - 2026-06-20

### Changed (Price-floor audit → auto-correction)
- **`/api/health/price-audit` now corrects, not just alerts** (`price-audit.ts`, `route.ts`).
  The daily 09:30 UTC cron still detects Shopify variants priced below the Aosom floor, but now
  immediately pushes the corrected floor price back to Shopify (`updateShopifyVariantPrice`) and
  logs each fix to `price_history` with `change_type='floor_correction'` (`applied_to_shopify=1`
  on success, `0` on a failed push / unmatched variant — kept as an audit trail).
- **Per-run safety cap** — corrections are pushed worst-gap first, capped at
  `MAX_CORRECTIONS_PER_RUN` (200) so a large backlog (first run after deploy, or a sync
  regression) can't exhaust the 300s cron budget; the overflow is reported as `deferred` and
  drained by the next daily run. The corrected price reuses `targetSellPrice`, so it can never
  push `$0`/`NaN`/below-floor; recording is best-effort (a successful push is never downgraded to
  failed by a history-write error).
- **Dashboard "Alertes" panel** (`alerts-panel.tsx`) — green card for auto-corrected variants
  (Shopify price → floor), red card for failed corrections (need manual attention), amber for
  deferred. Legacy pre-deploy summaries still raise a below-floor alert via a fallback.
- **`getRecentPriceChanges` excludes `floor_correction`** (`database.ts`) so audit auto-corrections
  (shown on the dedicated floor card) don't crowd real feed-driven price changes out of the
  sync-history feed.
- Tests: `price-audit` (correction success/failure/missing-variant, best-effort recording,
  per-run cap worst-first, persisted-summary shape) and `dashboard-db` (settings → priceFloor
  contract incl. legacy fallback, recent-changes floor_correction exclusion).

## [0.5.53.110] - 2026-06-19

### Added (Back-in-stock waitlist — storefront "notify me", CASL double opt-in)
- **`back_in_stock_waitlist` table** (`database.ts`) — one row per `(email, sku)` with
  `confirmed` / `confirm_token` / `token_expires_at` (double opt-in) + `notified_at`, plus
  `idx_waitlist_sku_pending`. Helpers: `upsertWaitlistEntry` (stores unconfirmed, re-arms on
  re-signup), `confirmWaitlist` (single-use token, 24h expiry), `getPendingWaitlist`
  (confirmed + un-notified only), `markWaitlistNotified`.
- **`POST /api/waitlist`** — public storefront signup (CORS allow-list, per-IP + 1/email/SKU/hr
  rate limits, email + SKU validation, SKU must exist). Stores unconfirmed and sends a Klaviyo
  **"Back In Stock Confirmation"** event with a confirm link. **`GET /api/waitlist/confirm`**
  flips the row to confirmed and redirects to the product page. Both allow-listed in `proxy.ts`.
- **Restock trigger (`job1-sync.ts`)** — `detectChanges` collects SKUs that restock `0 → >5`
  units; `notifyBackInStockWaitlist` fires a Klaviyo **"Back In Stock"** event
  (`sku, title_fr, price, product_url, image_url`) to each confirmed, un-notified subscriber and
  stamps `notified_at` per-recipient (crash-safe, no double-send). Wired into **both** `runSync`
  (manual trigger) and `runSyncInit` (the daily cron path). No-ops when Klaviyo is unconfigured.
- Tests: `waitlist-route`, `waitlist-confirm-route`, `waitlist-db` (10 cases).

## [0.5.53.109] - 2026-06-19

### Added (out-of-stock "Populaire" badge — preview theme)
- **`scripts/apply-out-of-stock-badge.mjs`** — one-off Shopify Asset API edit for
  the preview theme (160213696617). On `sections/main-product.liquid`: inserts a
  `<div class="popular-badge">⭐ Article populaire — Revenez bientôt !</div>` after
  the product `<h1>`, gated on `product.tags contains 'out-of-stock'`, plus the
  `.popular-badge` amber CSS in the existing `{%- style -%}` block. On
  `snippets/card-product.liquid`: a `⭐ Populaire` badge in both `card__badge`
  blocks gated on `card_product.tags contains 'out-of-stock'`, plus
  `.popular-badge-card` amber CSS via a `{% style %}` block (loads on collection
  pages). Dry-run by default; `--apply` writes; idempotent; verify retries past
  the Asset API's read-after-write lag. Applied to the preview theme. Run under
  x64 node — see CLAUDE.md "Windows ARM64".

## [0.5.53.108] - 2026-06-19

### Added (stock-state tags: out-of-stock / back-in-stock)
- **`src/lib/diff-engine.ts`** — `applyStockTags(tags, inStock)` + `productInStock(variants)`:
  product-level stock-state tags driven off the BUFFERED availability. A product is in stock when
  ANY variant buffers > 0 → `back-in-stock`; all buffer to 0 → `out-of-stock` (mutually exclusive
  pair, other tags preserved, case-insensitive de-dup). `diffProduct` emits a `tags` change only when
  the resulting set differs from Shopify's current tags (fires on the >0↔0 transition; no churn).
- **`src/jobs/job1-sync.ts`** — `applyToShopify` recomputes the tag set and pushes it via
  `updateShopifyProduct` (now accepts `tags`); logs `stock tags: <product> → back-in-stock|out-of-stock`.
- **`src/lib/shopify-client.ts`** — product fetch now includes `tags` (comma-split onto
  `ShopifyExistingProduct.tags`); `ChangeType` gains `"tags"`.
- **`scripts/backfill-inventory.mjs`** — product-level tag pass sets each product's current stock-state
  tag; conservative (skips products with no `products`-table qty). Same dry-run / `--apply` gate.
- Tests: `applyStockTags` pair behavior + case-insensitive de-dup, `computeDiffs` tag transitions.

## [0.5.53.107] - 2026-06-19

### Fixed (Oversell stop-gap — tag qty=0 products)
- **`scripts/fix-zero-stock.mjs`** — one-shot: tag the imported products whose Aosom
  stock is qty=0 with `out-of-stock`, so they're flagged while inventory tracking is
  still off (dropship `inventory_management: null` → they stay orderable despite zero
  supplier stock). Stop-gap until the inventory-tracking + stock-buffer feature lands.
  GETs current tags and **appends** `out-of-stock` to the merged set — a plain
  `PUT { tags: "out-of-stock" }` would WIPE all existing tags (Shopify replaces the
  field wholesale), so the read-merge-write is mandatory. Status left untouched (Active
  stays Active — no draft/archive). Dry-run by default; `--apply` writes; backs up
  original tags to `data/shopify-backup/` (gitignored) first; 2 req/s throttle;
  idempotent (skips already-tagged). Applied to prod: 16 tagged, 0 failed, 1 skipped
  (product 7752227815529 returned 404 — deleted from Shopify since the catalog snapshot).
  Run under x64 node (see CLAUDE.md).

## [0.5.53.106] - 2026-06-19

### Added (Shopify inventory tracking + stock safety buffer)
- **`src/lib/shopify-client.ts`** — three inventory functions: `getPrimaryLocationId()`
  (`GET /locations.json`, cached), `enableVariantTracking(inventoryItemId)`
  (`PUT /inventory_items/{id}.json {tracked:true}` — the supported path on API 2025-01,
  where writing `variant.inventory_management` is deprecated), and
  `setInventoryLevel(inventoryItemId, locationId, available)` (`POST /inventory_levels/set.json`,
  with a `connect.json` fallback on the not-stocked 422). `fetchAllShopifyProducts` now maps
  `inventory_item_id` onto each variant (`ShopifyExistingVariant.inventoryItemId`).
- **`src/lib/diff-engine.ts`** — reactivated the variant stock diff (disabled since dropship
  went untracked). New exported `stockBufferQty(qty)`: **`qty <= 5 → 0` (épuisé), else `qty - 3`**.
  Emits a `stock` change only when the buffered qty differs from Shopify's current available
  (no no-op churn). `summarizeDiffs` counts `stockChanges` again.
- **`src/jobs/job1-sync.ts`** — `applyToShopify` pushes buffered stock on `update` diffs:
  `enableVariantTracking` then `setInventoryLevel(inventory_item_id, locationId, safeQty)`,
  logging `stock buffer applied: aosom=X → shopify=Y`.
- **`scripts/backfill-inventory.mjs`** — one-time migration for the existing catalogue:
  per variant, enable tracking + set the buffered level (qty from the `products` table).
  Dry-run by default (`--apply` to write, `--limit N`), 2 req/s throttle, pre-migration
  backup to `data/shopify-backup/`, idempotent. Logs `SKU X : aosom=Y → shopify=Z`.
- Tests: `stockBufferQty` boundary (5→0, 6→3) + diff/no-diff stock behavior.

⚠️ **Activation is gated.** The current `SHOPIFY_ACCESS_TOKEN` lacks `read_locations` /
`read_inventory` / `write_inventory` — add those scopes before any live push. Enabling
tracking with `inventory_policy=deny` (all 1126 variants today) makes a variant at
available=0 **unbuyable**; measure how many `products.qty <= 5` before the backfill. Run the
backfill (`--apply`) only after scopes are confirmed + a checkpoint. Daily sync stock-push
should be enabled only after the backfill, so the first run doesn't flood the Phase-2 queue.
## [0.5.53.105] - 2026-06-19

### Fixed (meta-ads-dpa-create — make `--apply` actually work against Graph v18)
- **`scripts/meta-ads-dpa-create.mjs`** — the v0.5.53.104 `--apply` path was untested and failed
  on live Graph API. Fixed against the real account config (discovered via read-only probes of
  working ad sets):
  - **Objective** `PRODUCT_CATALOG_SALES` → **`OUTCOME_SALES`** (legacy objective is rejected
    `(#100)` on v18) + `is_adset_budget_sharing_enabled: false` (required when budget is on the ad set).
  - **Pixel**: the ad set's `promoted_object` needs the **ad-account conversion pixel**, which is
    NOT the storefront `NEXT_PUBLIC_META_PIXEL_ID` — a wrong pixel fails with a generic `(#2)`.
    Resolved via `--pixel-id` / `META_ADS_PIXEL_ID`.
  - **Ad set**: `destination_type: "WEBSITE"`; dropped `product_catalog_id` from `promoted_object`
    (unsupported for the resolved objective); **Facebook-only placements** (`publisher_platforms:
    ["facebook"]`) since the account has no ads-linked Instagram account (an all-placements ad set
    forces an IG actor it can't supply).
  - **Resume flags** `--product-set-id` / `--campaign-id` / `--adset-id` to continue after a
    mid-chain failure instead of orphaning fresh PAUSED objects (Meta rejects a duplicate
    product-set filter `(#10803)`).
- Verified end-to-end: both campaigns created (all PAUSED, $3/day) — see "Été 2026" in
  `docs/META-ADS-SETUP.md`.

## [0.5.53.104] - 2026-06-19

### Added (Meta DPA campaign builder — summer + best-sellers)
- **`scripts/meta-ads-dpa-create.mjs`** — builds a full Dynamic Product Ads (PRODUCT_CATALOG_AD)
  object chain from the catalog: product_set → campaign → ad set → ad creative → ad, **all
  created PAUSED** (nothing spends until activated in Ads Manager after review). Two campaigns:
  - `--campaign bestsellers` — top movers by the catalog's canonical 14-day velocity
    (`SUM(old_qty - new_qty)` over `price_history` `change_type='stock_change'`, restocks
    excluded — same definition as the `best_sellers` catalog sort), in-stock + live only.
  - `--campaign summer` — in-stock, live `product_type LIKE 'Patio & Garden%'` (the catalog's
    seasonal taxonomy), ranked by the same velocity.
  - Product set uses `{retailer_id:{is_any:[…SKUs]}}` — retailer_id == our variant SKU (catalog feed).
  - DRY-RUN by default (prints selected SKUs + every payload, zero network, DB untouched);
    `--apply` creates; `--limit N` / `--daily-budget` / `--ad-account` flags. Created ids are
    logged to `docs/META-ADS-SETUP.md` ("Été 2026" section). Meta OAuth error **#190** stops the
    run with a token-rotation advisory (never spends). Distinct from `meta-ads-create.mjs`
    (which attaches a creative+ad to the existing FR/EN retargeting campaigns).

## [0.5.53.103] - 2026-06-18

### Added (`--repoll-errors` recovery mode for Meta advideos)
- **`scripts/upload-meta-advideos.mjs`** — new `--repoll-errors` mode recovers rows stuck in
  `meta_status='error'` whose advideos upload actually succeeded (`meta_video_id` is set) but
  whose ready-poll failed mid-batch — e.g. Meta `(#4) Application request limit reached` after
  ~70 uploads. It selects `WHERE meta_status='error' AND meta_video_id IS NOT NULL`, re-polls
  each existing video id (`GET /{id}?fields=status` until ready/error), and updates only
  `meta_status` — **never re-uploads**, so it can't create duplicate videos in the ad library.
  Dry-run by default (lists candidates, DB untouched); `--apply` writes; `--limit N` caps the
  batch. Exits non-zero if any row is still in error. Run under x64 node (see CLAUDE.md).
  Context: the v0.5.53.96 `--apply` run landed 70/87 ready and left 17 in error (SKUs
  84C-226CG, 84H-209V00CG, D51-277V01) when the Graph app quota tripped during polling.

## [0.5.53.102] - 2026-06-18

### Fixed (Brand sanitization — product URL handles, round 2)
- **`scripts/fix-shopify-handles-2.mjs`** — de-brand the 117 Shopify product handles
  that still embedded a supplier brand (`outsunny` ×113, `qaba` ×4 distinct — Google
  feed audit found 160 `<link>` incl. variant dupes, 117 distinct products). Follow-up to
  `fix-shopify-handles.mjs` (PR #208, which only stripped `aosom`). Strips the dash-anchored
  brand token, renames via `PUT /products/{id}`, and **explicitly creates a 301**
  (`POST /redirects.json`) per rename — the REST API does NOT auto-redirect (verified live;
  the brief's auto-301 assumption was wrong), so without this the old indexed URLs would 404.
  Dry-run by default; `--apply` writes. Backs up all originals to `data/shopify-backup/`
  (gitignored) before any write; 2 req/s throttle + 429 backoff; idempotent (re-run skips
  renamed handles, existing 301 → 422). Applied to prod: 117 renamed, 0 failed, 0 redirect
  failures; re-scan 0 branded handles, 301→200 verified. Run under x64 node (see CLAUDE.md).

## [0.5.53.101] - 2026-06-18

### Added (Demand Gen videos dashboard)
- **`src/app/(dashboard)/demand-gen-videos/`** — read-only dashboard page listing
  the `video_demand_gen` assets (87 rows): SKU, FR title, ratio, duration, size,
  Meta/YouTube upload badges (green when `meta_video_id` / `youtube_video_id` is
  set), and a ▶ link to the public blob. Filterable by ratio and SKU, with
  total / Meta `X/87` / YouTube `X/87` counters.
- **`getDemandGenAssets()`** in `database.ts` and **`GET /api/demand-gen-videos`**
  (auth-gated, https-only blob URLs) back the page. Uploads remain script-driven
  (`upload-meta-advideos.mjs`, `upload-youtube.mjs`) — this view is read-only.
- Sidebar nav entry "Demand Gen" (hidden from the reviewer role).

## [0.5.53.100] - 2026-06-18

### Changed (comment cleanup — retire stale social-scheduled references)
- **`src/app/api/social/route.ts`**, **`src/jobs/job1-sync.ts`**, **`src/lib/database.ts`** —
  updated 3 stale code comments that referenced the removed `social-scheduled` cron as if it
  still ran. The `cron_runs` retention notes cited "social-scheduled alone = 96/day"; that cron
  was deleted in v0.5.53.97, so the notes now point at the live high-frequency crons (publisher
  hourly, csv-precache 4x/day). No behavior change.

## [0.5.53.99] - 2026-06-18

### Fixed (approveDraft auto-schedule → publication_queue; remove dead social-scheduled code)
- **`src/app/(dashboard)/drafts/actions.ts`** — `approveDraft()` auto-scheduled `content_template`
  drafts by writing `facebook_drafts.status='scheduled'` onto the M/W/F grid, drained by the
  `social-scheduled` cron. That cron was retired in v0.5.53.93, so those rows would never publish.
  It now enqueues into `publication_queue` (one item per active brand via `draftToQueueItems`) on
  the next free `publication_schedule` slot — same path as `/api/social {action:"approve"}` —
  leaving the draft `approved`. Slot collisions retry past the taken slot (`QueueSlotTakenError`).
  Behavior note: auto-scheduling now respects `publication_schedule.enabled`; if disabled, the
  draft stays `approved` and unscheduled (was always M/W/F before).

### Removed (dead `social-scheduled` path)
- **`src/app/api/cron/social-scheduled/route.ts`** — deleted. The route was already out of
  `vercel.json` (v0.5.53.93) and was the only caller of `processScheduledDrafts()`.
- **`processScheduledDrafts()` in `src/jobs/job4-social.ts`** — deleted, plus its now-orphaned
  `getFacebookDrafts` / `claimFacebookDraft` / `updateFacebookDraft` imports.
- **`tests/scheduled-posts.test.ts`** — deleted (covered the removed function + route).
- `draft-scheduler.ts` is **kept**: `isSqliteUtc` (validates queue slots in `addToQueue`) and
  `nextFreeSlot` (`/api/queue/add`) are still live.

### Tests / docs
- **`tests/approve-draft-queue.test.ts`** — 6 cases: content_template enqueue, bilingual earliest
  slot, schedule-disabled no-op, non-content_template skip, `QueueSlotTakenError` retry, best-effort
  swallow on enqueue failure.
- Updated the CLAUDE.md publication-scheduling section and a stale `social/page.tsx` comment.

## [0.5.53.98] - 2026-06-18

### Fixed (enqueue orphaned approved drafts into publication_queue)
- **`scripts/fix-orphan-drafts.mjs`** — one-off backfill for 6 approved
  `facebook_drafts` (ids 345, 332, 324, 287, 282, 281) that predated the queue
  cutover and were never enqueued, so neither cron path would ever publish them.
  Replays the `/api/social` `approve` path exactly — reuses `draftToQueueItems`,
  `getNextAvailableSlot`, and `addToQueue` rather than reimplementing scheduling
  or payload logic, so it can't drift from production behavior. Enqueues
  platform-correct, publishable items (`caption` + `brand`) onto the next free
  `publication_schedule` slots, with per-platform occupancy accumulated in-memory
  so each item lands on a distinct slot. Dry-run by default; `--apply` writes.
  Idempotent — skips any `(content_id, platform)` already in the queue. Applied to
  production: 11 items enqueued (6 ameublo `both` + 5 furnish `facebook`), 0
  approved orphans remain. Run under x64 node — see CLAUDE.md "Windows ARM64".

## [0.5.53.96] - 2026-06-18

### Changed (publisher cron run summary in cron_runs.detail)
- **`src/lib/cron-tracking.ts`** — `trackCron` now takes an optional `summarize(result)`
  callback that records a one-line `detail` on success, so the dashboard "Résumé du jour"
  shows what a run did, not just that it ran. Backward-compatible: all 9 existing 2-arg
  callers are unchanged. The summarizer runs after `fn` resolves and is best-effort — a
  throw inside it is swallowed (detail dropped), never turning a run whose work already
  succeeded into a failure (same posture as `safeRecord`'s write failures).
- **`src/app/api/cron/publisher/route.ts`** — passes a summarizer that records
  `"X due, Y published, Z failed"` (due = items the run saw this hour, handled + deferred
  past the time budget). Previously the publisher's `cron_runs.detail` was always empty, so
  hourly runs were indistinguishable on the dashboard whether they published 0 or 5 posts.
- Tests: `tests/cron-tracking.test.ts` adds coverage for the success-detail path and the
  summarizer-throw safety net.

## [0.5.53.95] - 2026-06-18

### Fixed (Typecheck — demand-gen test)
- **`tests/load-demand-gen-db.test.ts`** — `buildRows(...).find(...)` returns `T | undefined`,
  so accessing `.title_fr` / `.shopify_product_id` tripped `TS18048 'r' is possibly undefined`
  under `tsc --noEmit` (the project's typecheck was red on `main`). Added an `if (!r) throw`
  guard that narrows the type and fails the test clearly if the expected `01-0415` row ever
  goes missing, instead of silencing it with a non-null assertion.

## [0.5.53.94] - 2026-06-18

### Fixed (Brand sanitization — EN title metafields)
- **`scripts/fix-title-en.mjs`** — one-off de-brand of the 6 `custom.title_en`
  metafields that still opened with the supplier brand `Outsunny ` (all other EN
  titles were already clean — full-catalog audit: 638 products scanned, 6 offenders,
  0 HOMCOM/Aosom/Qaba). Strips a leading `Outsunny ` (case-insensitive) and `PUT`s
  the cleaned value back via the Admin API, preserving the metafield `type`. Dry-run
  by default; `--apply` writes. Idempotent (re-run is a no-op) and guards against
  emptying a title. Applied to production: all 6 fixed, re-scan confirms 638/638
  EN titles brand-free. Run under x64 node — see CLAUDE.md "Windows ARM64".

## [0.5.53.93] - 2026-06-18

### Changed (retire the `social-scheduled` cron; unify scheduling on `publication_queue`)
- **`vercel.json`** — removed the `/api/cron/social-scheduled` cron (was `0,15,30,45 * * * *`,
  96 runs/day). The `facebook_drafts.status='scheduled'` queue it drained is empty, so it ran
  to nothing every 15 minutes.
- **`src/app/api/social/route.ts`** — `{action:"schedule"}` no longer writes a `scheduled`
  facebook_draft. It now enqueues the draft into `publication_queue` at the operator-chosen
  time (one item per active brand via `draftToQueueItems`), leaving the draft `approved` —
  the same path as `approve`, published by `/api/cron/publisher`. With the legacy cron gone, a
  `scheduled` row would never publish, so writing one would have been a silent no-op.
- **`src/app/api/social/drafts/[id]/schedule/route.ts`** — same redirect for the REST schedule
  endpoint used by the `/drafts` page. POST cancels the draft's existing pending queue rows
  first (re-schedule moves the post, no duplicate), then enqueues at the chosen slot; DELETE
  cancels the pending rows and reverts the draft to `draft`. A slot already taken on a platform
  (`QueueSlotTakenError`) skips that brand rather than shifting the chosen time.
- **`src/lib/database.ts`** — new `cancelPendingQueueItems(contentType, contentId)`: flips a
  content item's still-`pending` queue rows to `cancelled` (freeing their slots), leaving
  `publishing`/`published` rows untouched. Backs re-schedule and unschedule.
- **`src/app/(dashboard)/drafts/drafts-client.tsx`** — schedule helper copy updated: posts now
  enter the publication queue and fire at the chosen time (hourly publisher), not the removed
  15-minute cron.
- **Tests** — `tests/social-schedule-queue.test.ts` and `tests/drafts-schedule-route.test.ts`
  (12 cases): enqueue at the chosen slot, bilingual one-item-per-brand, `QueueSlotTakenError`
  skip, past/missing-time → 400, missing draft → 404, terminal draft → 409, DELETE cancels +
  reverts.

## [0.5.53.92] - 2026-06-18

### Added (YouTube uploader for Demand Gen)
- **`scripts/upload-youtube.mjs`** — uploads the 16:9 Demand Gen assets recorded in
  `video_demand_gen` to YouTube via Data API v3 (`videos.insert`, resumable), then writes
  `youtube_video_id` + `youtube_status` back into each row. Raw `fetch` (no googleapis SDK):
  OAuth2 `refresh_token` → access token, then resumable init → single-shot PUT. Source bytes
  come from `blob_url` (runs from any clone). `privacyStatus: unlisted`. Descriptions link to
  the real storefront product via its **handle**, resolved from the Shopify Admin API (the
  `shopify_product_id` column is a GID, which the storefront can't resolve). **DRY-RUN by
  default** (lists candidates, zero YouTube quota); `--apply` uploads, `--limit N` batches,
  `--force` re-uploads. Hard quota guard: refuses any run over the 10000-unit/day quota
  (~6 uploads/day at 1600 units each), escapable only by `--limit`. Idempotent — rows with a
  `youtube_video_id` are skipped. Run under x64 node (see CLAUDE.md).

## [0.5.53.91] - 2026-06-18

### Changed (Demand Gen overlay retouches)
- **`scripts/render-demand-gen.mjs`** — overlay redesign for the Demand Gen video assets:
  - Title moved to the TOP safe zone (y=15%) and **+25%** larger; benefit line is now a
    Gold pill (Navy text) at the BOTTOM safe zone (y=82%).
  - **Titles UPPERCASE** via `toLocaleUpperCase("fr-CA")` (FFmpeg `drawtext` has no
    `upper()` — it renders the literal token; fr-CA handles é→É, à→À, ç→Ç).
  - **Navy backing box** behind each title line (`box=1:boxcolor=0x1B2A4A@0.70:boxborderw=4|8`,
    i.e. 4px vertical / 8px horizontal padding; square corners — FFmpeg has no rounded box).
  - **Scrim** strengthened: Navy peak alpha 0.35→**0.50**, band height 18%→**25%**.
  - Title pipeline now `sanitizeTitle` (strip em/en dashes) + `truncate` to 35 chars + max 2
    lines; faux-bold via same-color outline; optional CLI SKU filter for canary re-renders.
  - Scrim color reuses the `NAVY` const instead of a duplicated `0x1B2A4A` literal.
- **`scripts/build-index.mjs`** — contact-sheet caption updated to describe the new overlay
  (titre MAJUSCULES +25%, fond Navy 70%, scrim Navy 50%).

### Added
- **`scripts/preview-server.mjs`** — tiny static server (`:8080`) for the Demand Gen contact
  sheet, used to visually validate canary re-renders before a full batch.

## [0.5.53.90] - 2026-06-18

### Added (Meta ad video upload — advideos file_url ingest)
- **`src/lib/meta-ads-client.ts`** — `uploadAdVideo(adAccountId, { fileUrl, name })` (POST
  `/act_<id>/advideos` via server-side `file_url` ingest — Meta fetches the public MP4
  itself), `getAdVideoStatus(videoId)` (GET `/{videoId}?fields=status`, normalized to
  `ready`/`processing`/`error`), and `pollAdVideoReady(videoId, { timeoutMs=300_000, intervalMs=5_000 })`
  (polls until ready, throws on Meta error or timeout). Fills the `video_demand_gen.meta_video_id`
  pipeline.
- **`scripts/upload-meta-advideos.mjs`** — pushes rendered Demand Gen videos into the Meta ad
  library and records the result. Selects `video_demand_gen WHERE meta_video_id IS NULL`, uploads
  each `blob_url` → polls status → `UPDATE meta_video_id + meta_status`. Dry-run by default
  (lists candidates, no network mutation, DB untouched); `--apply` to execute; `--limit N` /
  `--ad-account act_…` flags. Throttled to ≤2 Graph req/s. Idempotent (recorded rows skipped;
  upload failure leaves `meta_video_id` NULL for retry). `advideos` only ingests — it never
  spends. Run under x64 node (see CLAUDE.md). Verified dry-run: 87 pending assets.

## [0.5.53.89] - 2026-06-18

### Docs (Meta token rotation runbook)
- **`docs/META-TOKEN-ROTATION.md`** — step-by-step to replace the short-lived USER
  `META_ACCESS_TOKEN` (issued 2026-06-07, ~60-day lifetime) with a non-expiring
  **System User** token: creation steps, required scopes (`ads_read`, `ads_management`,
  `business_management`, `catalog_management`), where to update (`.env.local` + Vercel
  Production + Preview, with redeploy note), and a `debug_token` verification command.
  ⏰ Rotate **before 2026-08-06** (hard data-access cutoff 2026-09-07).

## [0.5.53.88] - 2026-06-18

### Added (Demand Gen video URL persistence)
- **`src/lib/database.ts`** — new `video_demand_gen` table in `initSchema`: durable index
  of the rendered+uploaded Demand Gen assets, one row per `(sku, ratio, duration_sec)`.
  Holds the Vercel Blob source URL plus reserved `meta_video_id` / `youtube_video_id` +
  `*_status` columns for the downstream ad-push jobs (Meta `advideos` `file_url` ingest,
  YouTube upload for Google Demand Gen).
- **`scripts/load-demand-gen-db.mjs`** — reads `out/demand-gen-manifest.json`, upserts the
  87 assets into `video_demand_gen` (idempotent via `ON CONFLICT` — refreshes source fields,
  preserves downstream IDs), and emits `docs/demand-gen-urls.json`. Dry-run by default;
  `--apply` writes to Turso (run under x64 node — see CLAUDE.md "Windows ARM64").
- **`docs/demand-gen-urls.json`** — committed human-readable snapshot of the 87 blob URLs.

## [0.5.53.87] - 2026-06-18

### Fixed (Brand sanitization — URL handles)
- **`src/lib/content-generator.ts`** — added `stripSupplierBrands()`, a deterministic
  backstop that removes supplier brand tokens (Outsunny, HOMCOM, Aosom, Vinsetto, PawHut,
  Soozier, Qaba, ShopEZ, Wikinger, Portland, Aousthop) from a string. Applied to both
  `urlHandleFr` and `urlHandleEn` before `slugify()`, so a brand name the model echoes
  into a handle can no longer leak into product URLs (e.g. `/products/outsunny-...`). The
  system prompt already forbids brand names; this enforces it in code. Tests added in
  `tests/content-generator.test.ts` (case-folding, kebab-embedded brands, word-boundary guard).
  Also reuses this shared helper for the title safety net introduced in 0.5.53.86 (replacing
  that change's inline regex), so titles and handles strip brands through one code path.

## [0.5.53.86] - 2026-06-18

### Fixed (Supplier brand names in generated titles)
- **`src/lib/content-generator.ts`** — programmatic safety net after the Claude response:
  strip supplier brands (Outsunny, HOMCOM, Aosom, Vinsetto, PawHut, Soozier, Qaba,
  ShopEZ, Wikinger, Portland, Aousthop) from `titleFr`/`titleEn`. The model is instructed
  never to put the supplier brand in the title but sometimes does anyway; this enforces it
  deterministically. Runs before the length / meta-title / URL-handle derivation so those
  stay brand-free too. Adds 3 regression tests covering leading, mid-title, case-insensitive,
  and multiple-brand stripping (plus clean-title pass-through).

### Chore
- Synced `package.json` version to `VERSION` (drift from a prior bump that updated VERSION only).

## [0.5.53.85] - 2026-06-18

### Added (Meta token verification)
- **`scripts/verify-meta-token.mjs`** — read-only/dry-run check of `META_ACCESS_TOKEN` via
  Graph `debug_token`. Reports token **type** (`USER` vs `SYSTEM_USER`), `expires_at` +
  `data_access_expires_at` (with relative/expired hints), validity, and granted **scopes**
  (flags missing `ads_read`/`ads_management`). GET-only — never creates, edits, or rotates
  anything. Run under x64 node (see CLAUDE.md). Reference: `docs/META-ADS-SETUP.md` §2.

## [0.5.53.84] - 2026-06-17

### Added (Demand Gen video pipeline + uploader)
- **`scripts/render-demand-gen.mjs`** — FFmpeg renderer that turns real product MP4s into
  branded Demand Gen ad assets: trims each clip's clean window (skips burned-in EN title
  cards), scales/pads to 16:9 · 1:1 · 9:16 at 6s/15s/30s, overlays the FR product title +
  "Livraison gratuite au Canada" (DM Sans), and `delogo`s the supplier corner logo. Reads
  `src/*.mp4` → writes `out/demand-gen/{sku}/`. Produced 87 assets from 13 viable sources.
- **`scripts/build-manifest.mjs` / `scripts/build-index.mjs`** — build
  `out/demand-gen-manifest.json` (per-source trim/delogo/variant plan + audit notes) and a
  local preview contact sheet.
- **`scripts/upload-demand-gen.mjs`** — uploads the rendered assets to Vercel Blob (`put()`,
  public, `demand-gen/{sku}/{file}`) and records each `blob_url` back into the manifest.
  Dry-run by default; `--apply` to upload; 2 uploads/sec; idempotent (skips already-recorded
  assets; atomic re-read + merge of the manifest so a concurrent renderer's writes aren't
  clobbered); refuses a partially-rendered set unless `--force`.
- **`fonts/DMSans.ttf`** — brand font for the overlay.

### Changed
- **`.gitignore`** — ignore `src/*.mp4` (73MB of source product videos, re-fetchable via the
  manifest `source_url`) and `tmp_lines/` (FFmpeg drawtext scratch).

## [0.5.53.82] - 2026-06-17

### Changed (vitest skips agent worktree copies)
- **`vitest.config.ts`** — `test.exclude` now `[...configDefaults.exclude, '**/.claude/**', '**/out/**']`.
  Parallel agent sessions create full repo copies under `.claude/worktrees/`; without
  this, vitest discovered and ran their (stale) test files from the main clone. Spreads
  `configDefaults.exclude` so vitest's built-in ignores (node_modules, dist, …) are kept —
  a bare `exclude` would have overridden them and made vitest scan node_modules.

## [0.5.53.81] - 2026-06-17

### Added (debrand — product descriptions)
- **`scripts/fix-shopify-descriptions.mjs`** — one-off backfill that strips supplier brand
  names (Aosom, Outsunny, HOMCOM, Qaba, Soozier, Vinsetto, PawHut) from existing Shopify
  product `body_html`. Hybrid strategy: **mechanical strip** for the clean majority (brand
  word removed + spacing/punctuation repaired), **Claude rewrite** (`claude-sonnet-4-6`) for
  the minority where a plain strip would break grammar (brand after a preposition+punctuation,
  or brand at a sentence start). Dry-run by default; `--apply` performs the PUTs.
- Safety: dumps every original `body_html` to a timestamped `descriptions-backup-*.json`
  before the first write; refuses any cleaned body that still contains a brand, that came back
  truncated (`stop_reason: max_tokens`), or that lost >40% of its length; 2 req/s on Shopify
  with capped 429 backoff; idempotent (re-run only re-touches descriptions still carrying a brand).
- Scope at run time: 429/638 descriptions affected (400 mechanical + 29 Claude).
- **Supersedes the v0.5.53.80 `fix-shopify-descriptions.mjs`** (mechanical-only, 3 brands, no
  backup) — this version adds the original-`body_html` backup, truncation + length-loss guards,
  the Claude grammar-rewrite path, and 4 more brands (HOMCOM, Soozier, Vinsetto, PawHut). Neither
  version's `--apply` had been run, so no descriptions were touched by the replaced script.

## [0.5.53.80] - 2026-06-17

### Added (Shopify descriptions debrand tool — dry-run default)
- **`scripts/fix-shopify-descriptions.mjs`** — strips supplier brand tokens (Aosom, Outsunny,
  Qaba) from existing products' `body_html`, tidies the resulting spacing/punctuation/caps, then
  PUTs the cleaned description back to Shopify. Backfills the 429 live products that still carry a
  supplier name in their description (complements the generation-time content-generator fix in
  0.5.53.77 and the vendor debrand in 0.5.53.76 / 0.5.53.78).
- Dry-run by default (prints 5 before/after examples); `--apply` executes. Strict 2 req/sec,
  429 retry-after, and only writes products whose cleaned body actually changes.
- Cleanup also drops a leading preposition bound to the brand
  (`from/with/by/of/avec/de/du/des/par` + brand) so "cat tree from Aosom, rest" → "cat tree,
  rest" instead of leaving a dangling "from," (decided at the Mat checkpoint after dry-run).

## [0.5.53.79] - 2026-06-17

### Chore
- **`.gitignore`: add `.claude/` and `out/`.** `.claude/` keeps agent worktrees/scratch
  (e.g. `.claude/worktrees/` created by parallel sessions) out of commits; `out/` catches
  nested build-output dirs (root `/out/` was already ignored). Nothing under either path was
  tracked, so this untracks nothing.

## [0.5.53.78] - 2026-06-17

### Fixed (de-brand the import source — no supplier name on new products)
- **`createShopifyProduct` (`shopify-client.ts`) now sets the public `vendor` field to
  "Ameublo Direct"** instead of `merged.brand || "Aosom"`. New imports never surface the
  supplier name via the vendor field (feeds + analytics). The real supplier brand is still
  recorded internally in the `custom.brand_fr` metafield (unchanged — internal only).
- **`createBlogArticle` (`shopify-blog.ts`) default author byline "Aosom" → "Ameublo Direct"**
  — caught during review: any blog article created without an explicit author (e.g. the blog
  auto-publish cron) would otherwise show "Aosom" as the public byline.

## [0.5.53.77] - 2026-06-17

### Fixed (content generator — debrand)
- **`src/lib/content-generator.ts`** — stop the supplier brand from reaching generated content:
  the `[BRAND NAME]` placeholder now resolves to « Ameublo Direct » (was `product.brand`, the
  supplier name) in both the description and short description before Claude sees them; and the
  SYSTEM_PROMPT prohibition is broadened from the product title to **anywhere in the response**
  (full supplier list — Outsunny, HOMCOM, Aosom, … — unchanged).
- Note: `parsed.brand = product.brand` still records the supplier brand on the output object
  (tested behavior); debranding that field is a separate, follow-up decision.

## [0.5.53.76] - 2026-06-17

### Added (Shopify vendor debrand tool — dry-run default)
- **`scripts/fix-shopify-vendors.mjs`** — rewrites every Shopify product `vendor`
  to « Ameublo Direct » via the Admin API (`PUT /products/{id}.json`). Dry-run by
  default (prints the per-vendor count + a 10-item preview, no writes); `--apply`
  to execute. 2 req/s strict (≥500ms between calls), capped 429-retry/backoff,
  idempotent (skips products already conformant), logs `ancien vendor → "Ameublo Direct"`.
  Closes the supplier-name leak in the Shopify `vendor` field (analytics meta / feeds),
  complementing the JSON-LD `brand` which is already « Ameublo Direct ».
- Dry-run baseline (638 products): Aosom 606 · Qaba 29 · Soozier 2 · Outsunny 1 → all
  to « Ameublo Direct ». **`--apply` is gated on Mat's approval (not run by ship).**

## [0.5.53.75] - 2026-06-17

### Added (FAQ accordion visible sur les PDP — conforme Google Rich Results)
- **`shopify-theme/snippets/agentic-faq.liquid`** (nouveau) — accordéon FAQ **visible**
  (HTML5 `<details>/<summary>`, **zéro JS**, accessible : aria-labelledby, focus-visible)
  + FAQPage JSON-LD, générés depuis **une seule source** de 4 Q/R. Le balisage correspond
  donc exactement au contenu visible (exigence Google, sinon action manuelle). Tokens
  marque : Navy `#1B2A4A`, Gold `#D4A853`, police DM Sans (fallback système). Mobile-first.
- **`shopify-theme/snippets/agentic-structured-data.liquid`** — le FAQPage JSON-LD
  (auparavant invisible) en est **retiré** ; il vit maintenant dans `agentic-faq.liquid`
  pour éviter un doublon et garantir balisage = visible. Product JSON-LD inchangé.
- **`sections/main-product.liquid`** (thème live 160213696617) — `{% render 'agentic-faq' %}`
  inséré à la fin du bloc `description` → FAQ **après la description, avant les specs**.
  Voir `shopify-theme/README.md`.

## [0.5.53.74] - 2026-06-17

### Fixed (import de-brands product handles at the source)
- **`src/lib/shopify-client.ts` (`createShopifyProduct`)** — the Job 3 handle
  (`content.urlHandleFr` or `slugify(titleFr)`) is now stripped of the supplier name
  before the Shopify create: `.replace(/(^|-)aosom(-|$)/gi,'$1$2').replace(/--+/g,'-').replace(/^-|-$/g,'')`.
  The model sometimes embeds "aosom" despite the no-brand prompt rule, which leaked it
  into the public URL (347 existing handles were fixed in PR #208). This closes the loop
  so new imports don't re-introduce branded handles. The trailing trim prevents an orphan
  dash when "aosom" was a prefix/suffix. Tests added in `tests/shopify-client.test.ts`
  (mid/prefix/suffix/case-insensitive + title-fallback path).

## [0.5.53.73] - 2026-06-17

### Added (de-brand Shopify product handles — script, dry-run)
- **`scripts/fix-shopify-handles.mjs`** — renomme les handles produits contenant
  « aosom » pour retirer le nom du fournisseur des URLs (suite Projet #1, « 0 nom
  fournisseur »). **Dry-run par défaut** ; `--apply` requis pour écrire. Transform :
  `handle.replace(/(^|-)aosom(-|$)/g,'$1$2').replace(/--+/g,'-').replace(/^-|-$/g,'')`
  (couvre préfixe/suffixe/milieu — 347/347 handles). Throttle **2 req/sec strict** +
  backoff 429. Détecte les collisions (Shopify suffixe `-1`) et logge chaque `ancien → nouveau`.
- ⚠️ **Le renommage via l'API REST ne crée PAS de redirection automatique** (vérifié en
  prod 2026-06-17 : l'ancienne URL 404). Le script **crée donc explicitement** un 301
  (`POST /redirects.json` path → target) après chaque rename, avec le handle réellement
  stocké (gère `-1` collision) et saute les redirections existantes (422) en re-run.
  Diagnostic live : 638 produits, **347** handles « aosom », **2** collisions.
  Canary `--apply --limit 5` exécuté (5 renommés + 5 redirections 301 vérifiées live).
  ⚠️ `--apply` complet (342 restants) non exécuté — checkpoint Mat.

## [0.5.53.72] - 2026-06-17

### Added (SEO/AEO content engine — lot 1, dry-run)
- **`scripts/generate-seo-articles.mjs`** — generates FR SEO/AEO blog articles via the
  Anthropic API (`claude-sonnet-4-6`): structured JSON output, per-article constraint
  post-checks (no supplier names, no images, « livraison gratuite » ≤1×, méta ≤155 car.),
  2s rate-limit between calls. Writes `docs/seo-articles/<slug>.md`.
- **`scripts/fix-collection-handles.mjs`** — verifies internal-link collection handles
  against the Shopify Admin API (GET only, `custom_collections` + `smart_collections`)
  and corrects drift in the generated markdown.
- **`docs/seo-articles/` — 10 FR articles + `index.md`** across Mobilier extérieur /
  Meubles / Animaux / Enfants (informational, comparative, how-to). Each: ~150-word intro,
  H2/H3 body, 6-Q FAQ + valid FAQPage JSON-LD, accent-free slug, 2 internal collection links.
  Handles verified vs Shopify (1 corrected: `chaises-et-tables-de-patio-1`; 1 repointed to
  the real « Gazébos, parasols et abris » collection). **« Entrée et vestibule » flagged as a
  non-existent collection** — to create or repoint before publish.
- **`dry_run: true`** on every article — nothing pushed to Shopify; pending Mat's editorial approval.

## [0.5.53.71] - 2026-06-16

### Added (Projet #1 — visibilité commerce agentique, AEO/GEO)
Artefacts thème Shopify (déployés sur le thème `160213696617` via Asset API ; voir
`shopify-theme/README.md`) + livrable AEO. Non destructif côté données produits.

- **robots.txt — aucun override (décision après test en prod).** Le store sert déjà le
  défaut Shopify nouvelle génération, optimisé agents (`Allow: /` + publicité
  `agents.md` / `/.well-known/ucp` / UCP-MCP / `shop.app/SKILL.md`). Un
  `templates/robots.txt.liquid` custom **remplace** ce défaut riche par le ruleset
  classique et **supprime ces publicités UCP** = régression. Testé en prod puis
  rollback immédiat. Les agents IA listés sont déjà autorisés par le défaut. Voir
  `shopify-theme/README.md`.
- **`shopify-theme/snippets/agentic-structured-data.liquid`** — remplace
  `{{ product | structured_data }}` sur la PDP. Corrige la fuite `brand = product.vendor`
  (= fournisseur « Aosom ») en forçant `brand = shop.name` ; scrub des noms fournisseur
  dans la description ; `offers` en CAD avec `availability` + `priceValidUntil` ;
  `gtin`/`aggregateRating` (Judge.me) émis seulement si la donnée existe ; FAQPage JSON-LD.
- **`docs/aeo-format.md`** — gabarit de description optimisée agents IA
  (accroche → specs → cas d'usage → matériaux/entretien) + 3 exemples réels.

## [0.5.53.70] - 2026-06-16

### Added (multichannel product feeds)
- **`GET /api/feeds/bing`** — Bing / Microsoft Shopping feed (RSS 2.0 + g:; Microsoft ingests
  the Google Shopping format). Fields: id, title, description, link, image_link, price,
  availability, brand, product_type, shipping.
- **`GET /api/feeds/reddit`** — Reddit Dynamic Product Ads catalog feed (RSS 2.0 + g:). Fields:
  id, title, description, availability, condition, price, link, image_link, brand, product_type.
- Both reuse the shared `getFeedItems()`/`FeedItem` layer, the 10-min CDN window, and on-demand
  refresh via `POST /api/revalidate` (added to its feed list).

### Changed (Google feed enrichment + supplier de-branding)
- **Google feed now emits `g:color`** (derived from the SKU suffix via `parseSku`+`COLOR_MAP`,
  e.g. `…GY` → "Gris"; 859/999 items) and a constant **`g:shipping`** block (CA, 0 CAD).
- **Supplier name "Aosom" is hidden from all feeds** ("0 nom fournisseur"): the brand fallback
  is now "Ameublo Direct" (real product vendors like Outsunny/Qaba/Soozier are kept), and
  "Aosom" is scrubbed from feed titles + descriptions. Verified live: 0 occurrences in
  brand/title/description across 999 items.
  - **Known residual (Shopify-side follow-up):** 666/999 product **URL handles** still embed
    "aosom" (e.g. `/products/…-aosom-…`). These are live Shopify handles and can't be rewritten
    in the feed without 404ing the link — they need a Shopify-side handle rename + redirects.

### Fixed
- **`/api/revalidate` added to the proxy `PUBLIC_PATHS`.** It self-gates on Bearer CRON_SECRET
  (like `/api/cron`), but wasn't allowlisted, so the proxy 307-redirected it to `/login` before
  its own auth ran — the endpoint (shipped in v0.5.53.69) was non-functional. Now reachable.

## [0.5.53.69] - 2026-06-16

### Added (on-demand feed revalidation)
- **`POST /api/revalidate` (Bearer CRON_SECRET)** — refreshes the storefront product feeds
  (Google / Pinterest / Pinterest-EN / Meta / Meta-XML) on demand, e.g. right after a catalog
  sync, instead of waiting out the CDN cache. Calls `revalidateTag('feeds', 'max')` (busts the
  shared Shopify product Data Cache) + `revalidatePath` on each feed route. Returns
  `{ revalidated: true, feeds: [...] }`.
- **`src/lib/feeds/source.ts`** — the shared Shopify products fetch is now Data-Cached and tagged
  (`next: { revalidate: 86400, tags: ['feeds'] }`): a 24h baseline that `POST /api/revalidate`
  can invalidate early.

### Changed
- **Feed CDN window 24h → 10 min** (`s-maxage=600`) across all 5 feed routes, so on-demand
  revalidation propagates to the live feed within ~10 min. The heavy Shopify data stays in the
  Data Cache, so CDN re-pulls remain cheap. (Routes kept request-time; `force-static` was avoided
  because it would crawl Shopify at build and make deploys fragile. Per Next 16 `cdn-caching.md`,
  `revalidateTag`/`revalidatePath` bust Next's server cache but not the CDN copy — the 10-min
  `s-maxage` is the bounded propagation window, not an instant purge.)

## [0.5.53.68] - 2026-06-16

### Fixed (Google Merchant "Product page unavailable" on ~267 offers)
- **Storefront product feeds (Google / Pinterest / Meta) now exclude products that aren't live
  on the Online Store.** `shopifyToFeedItems` kept every `status:"active"` product, but ~78 of
  them are active-yet-unpublished (or scheduled for a future publish) — their `/products/{handle}`
  page 404s, so Google Merchant flagged the offers "Product page unavailable". The `g:link`
  handles were already correct (taken verbatim from Shopify's `handle`); the bug was *which
  products* shipped, not how the URL was built. Added `published_at` to the Shopify fetch and a
  mapper guard `if (!p.published_at || new Date(p.published_at) > now) continue;` (excludes
  never-published and not-yet-live scheduled products), with the excluded count logged.
- Note: the feed route is CDN-cached 24h (`s-maxage=86400`) — after deploy, purge/revalidate
  `/api/feeds/google` (and the Pinterest/Meta feed routes) so the fix takes effect immediately
  instead of after the cache expires.

## [0.5.53.67] - 2026-06-16

### Added (Instagram carousel — multi-photo posts)
- **`publishCarousel()` in `src/lib/instagram-client.ts`** — publishes a 2–10 image
  Instagram carousel via Meta's three-step Graph API flow: one child container per
  image (`POST /{ig-user-id}/media` with `is_carousel_item=true`, no caption on
  children), then a parent `CAROUSEL` container (`media_type=CAROUSEL`, `children=…`,
  caption), then `media_publish`. Image containers process near-instantly so there's
  no status polling (unlike `publishReel`). Every child upload must succeed — any
  failure throws before publishing, since a partial carousel would post in the wrong
  order or with missing photos. 500ms spacing between child uploads mirrors the FB
  album path; caption trimmed to 2200 chars like `publishPhoto`/`publishReel`.
- **`publishSocialPayload` Instagram routing** — `≥2 images → publishCarousel`,
  single image → `publishPhoto` (unchanged). Symmetric with the existing Facebook
  album branch. Images are capped at 10 (IG's limit) before the call. Routing lives
  in one place, so this covers both the draft path (`publishDraftToChannel`) and the
  queue path (`queue-publisher`).
- Tests: +8 (carousel payload shape, child-failure abort, 2–10 guard, container-error,
  and the `≥2 → carousel` / `>10 → cap` routing).

## [0.5.53.66] - 2026-06-16

### Added (unit tests for ensureSchema/initSchema retry — #186)
- **`tests/ensure-schema-retry.test.ts`** — covers the `initSchema()` retry contract that
  shipped without tests (#186, `DONE_WITH_CONCERNS`). Two cases: (1) when the schema-init
  impl throws, the memoized `schemaPromise` is nulled and the next call retries instead of
  re-throwing the cached rejection; (2) when the first attempt fails but the retry succeeds,
  init resolves, the success is memoized (no further re-runs), and the DB it initialized is
  accessible normally.
- **`src/lib/database.ts`** — added a small test-only DI seam (`activeInitSchemaImpl` behind
  `__setInitSchemaImplForTests` / `__getSchemaPromiseForTests`) so a fail-once-then-succeed
  impl can be injected without a live DB. Production behaviour is unchanged: `initSchema()`
  always runs the real `_initSchemaImpl` unless a test overrides it.

## [0.5.53.65] - 2026-06-16

### Fixed (dashboard "File de publication" read the wrong store)
- **The publication queue panel now reads `publication_queue` instead of `facebook_drafts`.**
  Since Approve switched to enqueuing into `publication_queue` (and stopped writing `scheduled`
  facebook_drafts), the panel — which fetched `/api/social?status=scheduled` — was showing a
  near-empty list. New **`GET /api/queue`** (session-auth) returns pending queue items
  (`getPendingQueue()`, oldest slot first) as a lean DTO: `scheduledAt` (converted from the
  table's UTC datetime TEXT to unix seconds), `platform`, `contentType`, `status`, a truncated
  caption/title `preview`, and an `https`-only `imageUrl`. Response capped at 50 items; full
  `payload` never leaves the server.
- **Panel UI** now shows, per post: scheduled time, platform (Facebook / Instagram / both / Blog),
  content preview, and a colour-coded status badge (pending / publishing / published / failed /
  cancelled).

## [0.5.53.64] - 2026-06-16

### Fixed (deprecated Claude model — sync content generation)
- **Replaced the deprecated `claude-sonnet-4-20250514` model ID with `claude-sonnet-4-6`** across
  the shared `CLAUDE.MODEL` constant (`src/lib/config.ts`), the standalone
  `scripts/fix-bilingual-content.js`, the `job1-sync` test fixture, and the `PLAN.md` default.
  Claude Sonnet 4 is deprecated; `claude-sonnet-4-6` is Anthropic's drop-in replacement. All
  callers use a plain `model` + `max_tokens` + `system` + single user-message shape (no assistant
  prefills, no `budget_tokens`/`temperature`), so the swap needed no other code changes. Note: the
  originally-proposed `claude-sonnet-4-5-20250514` was an invalid ID (would 404) and was not used.

## [0.5.53.63] - 2026-06-15

### Changed (Approve enqueues into publication_queue on the configurable schedule)
- **`src/app/api/social/route.ts`** — the `approve` action no longer writes a
  `scheduled` `facebook_draft` on the fixed Mon/Wed/Fri 15:00 UTC `draft-scheduler`
  grid. It now reads `publication_schedule` from settings, picks the next free slot via
  `getNextAvailableSlot` (publication-scheduler), and enqueues the draft into
  `publication_queue` (consumed by `/api/cron/publisher`). The draft stays `approved`
  in `facebook_drafts` — so `/api/cron/social-scheduled` can't also pick it up
  (no double-publish). Falls back to plain `approved` (no queue entry) when the
  schedule is disabled or no slot is free. Response keeps `scheduledAt` as unix
  seconds (the dashboard's contract) and adds `queued` / `queuedCount`.
- **`src/lib/social-publisher.ts`** — new `draftToQueueItems(draft, activeKeys)`:
  maps a draft to one valid `SocialQueuePayload` per brand (ameublo → FR `postText`,
  furnish → EN `postTextEn`), with brand-localized images and `platform` `"both"`
  vs the single active platform. Without this the queue consumer's
  `parseSocialPayload` (which requires `caption` + `brand`) would reject a raw draft
  and every approved post would fail to publish.
- **`src/lib/publication-scheduler.ts`** — `getNextAvailableSlot` now also returns
  `sqlite` (the slot as SQLite `datetime()` text), so the queue path gets the exact
  shape `addToQueue` requires without importing the converter from `draft-scheduler`.
- **`CLAUDE.md`** — documents the two publishing paths and the deprecation of
  `/api/cron/social-scheduled` for Approve (still serves the manual `schedule` action
  + legacy `scheduled` rows). `TODOS.md` tracks surfacing `publication_queue` in the UI.
- **Tests** — `tests/draft-to-queue-items.test.ts` (per-brand mapping: bilingual split,
  EN-caption-missing skip, single-platform collapse, image localization) and
  `tests/social-approve-queue.test.ts` (the approve route enqueues mapped payloads,
  per-brand fan-out, `QueueSlotTakenError` retry, disabled→fallback, 404).

## [0.5.53.62] - 2026-06-15

### Changed (de-dup FB/IG publish routing — no behavior change)
- **`src/lib/social-publisher.ts`** — new exported `publishSocialPayload(platform, payload)`:
  the single implementation of "which media → which Graph API call" (facebook: video →
  album → photo → text; instagram: reel → photo). `publishDraftToChannel` now builds a
  payload and delegates to it instead of carrying its own inline routing.
- **`src/lib/queue-publisher.ts`** — dropped its duplicate `publishToFacebook`/
  `publishToInstagram` (added in #193); `publishQueueItem` and the `both` path now call
  the shared `publishSocialPayload` (via a small `toSocialPayload` normalizer that folds a
  singular `imageUrl` into `imageUrls`). Both the draft and queue publish paths now share
  one routing implementation.
- Behavior-preserving refactor (verified equivalent: the `||`→`??` and array-length
  details are neutralized by `mapDraft`'s `|| null` / `length > 0` normalization). The
  only surface change is the Instagram no-media error text. New
  `tests/social-payload.test.ts` locks the routing contract; all existing
  social-publisher / queue-publisher tests stay green.

## [0.5.53.61] - 2026-06-15

### Added (blog auto-publish — quality + season gated, weekly-capped)
- **`src/lib/blog-auto-publish.ts`** — after the weekly blog cron creates a draft, an
  article goes **live** only if all gates pass: a Claude "judge" quality score
  >= `BLOG.AUTO_PUBLISH_SCORE_THRESHOLD` (80), the topic is **in season**, and the
  weekly cap isn't reached. `scoreArticle` runs a second Claude call (untrusted-content
  delimited to resist prompt injection); a judge failure leaves the article as a draft.
- **`src/lib/blog-topics.ts`** — each of the 30 topics tagged with a `season`
  (`spring|summer|fall|winter|all`); helpers `seasonOf`, `isSeasonActive`,
  `isTopicInSeason`, and `isoWeekKey` (ISO-week-year aware, so the cap counter never splits
  a week at the Dec/Jan boundary). `selectBilingualTopic` now carries the season.
- **`src/lib/shopify-blog.ts`** — `publishBlogArticle(blogId, articleId)` flips a draft
  live (`PUT … {published:true}`).
- **Weekly cap** — `blog_publish_counter` table + atomic `reserveBlogPublishSlot` /
  `releaseBlogPublishSlot` (a failed publish releases its slot). The cap and an on/off
  switch come from the existing **`blog_schedule`** setting (#194's `BlogSchedule`:
  `posts_per_week` + `enabled`), read via `parseBlogSchedule` — no new setting introduced.
- **`/api/blog/generate`** accepts `season` + `autoPublish` and runs the gate after
  creating the draft, returning `{score, published, publishReason}`. Manual/session calls
  default to draft-only (unchanged behavior). The weekly cron passes the topic season and
  `autoPublish: true`.
- Tests: season helpers + ISO-week-key boundary (`tests/blog-topics.test.ts`), the gate
  branches (`tests/blog-auto-publish.test.ts`), the atomic cap SQL (`tests/blog-publish-cap.test.ts`),
  and `publishBlogArticle` (`tests/shopify-blog-publish.test.ts`).

## [0.5.53.60] - 2026-06-15

### Added (configurable publication + blog schedule)
- **`src/lib/config.ts`** — `PublicationSchedule` / `BlogSchedule` types,
  `DEFAULT_PUBLICATION_SCHEDULE` (Mon/Wed/Fri/Sat local slots, `America/Toronto`,
  `max_per_day` 3) and `DEFAULT_BLOG_SCHEDULE` (2/week, Tue+Thu, 10:00), plus the
  `publication_schedule` / `blog_schedule` keys in `ALLOWED_SETTINGS_KEYS`.
- **`src/lib/database.ts`** — seeds both schedule blobs as `settings` defaults
  (`INSERT OR IGNORE`, no migration needed for existing DBs).
- **`src/lib/publication-scheduler.ts`** — new module: timezone/DST-aware slot math
  and `getNextAvailableSlot(platform, settings)` which reads `publication_schedule`,
  skips slots already occupied in the scheduled-draft queue, respects `max_per_day`,
  and returns the next free slot (unix seconds). Pure parse/normalize/enumerate
  helpers are fully unit-tested; wall-clock→UTC conversion resolves the offset twice
  so instants near a DST transition land correctly.
- **`src/app/api/settings/schedule/route.ts`** — `GET` returns the normalized
  schedules (defaults on missing/invalid); `PATCH` validates + persists each block
  (admin-only, reviewers forbidden). Out-of-range / invalid input is clamped or
  dropped rather than rejected (e.g. `max_per_day` 9→5, bad timezone→default).
- **`src/app/(dashboard)/settings/PublicationScheduleTab.tsx`** + **`page.tsx`** —
  new "Publication" tab on Settings: enable toggles, a day×time checkbox grid,
  `max_per_day` slider, timezone selector, and blog cadence (posts/week + preferred
  days/time). The existing settings move under a "Général" tab.
- **`tests/publication-scheduler.test.ts`** — 16 cases covering validators,
  parse/normalize (clamping, dedupe, weekday-order filtering, default fallbacks),
  slot enumeration (DST winter/summer), and `getNextAvailableSlot` (occupancy skip,
  `max_per_day` rollover, disabled→null).

## [0.5.53.59] - 2026-06-15

### Added (publication queue — consumer cron that drains the queue)
- **`src/app/api/cron/publisher/route.ts`** — new `GET /api/cron/publisher` (Bearer
  CRON_SECRET, same `timingSafeEqual` pattern as the other crons) + `POST` manual trigger
  (session). Wraps `drainPublisherQueue()` in `trackCron("publisher", …)` so the run lands
  in `cron_runs`. `maxDuration = 300`.
- **`src/lib/queue-publisher.ts`** — `drainPublisherQueue()` drains up to 5 due items: for
  each it `claimQueueItem` (atomic `pending → publishing`, skips if another instance won the
  claim — no double-publish), publishes, then `markPublished`/`markFailed`. 2s spacing
  between publishes; a wall-clock budget (240s, under maxDuration) stops claiming new items
  so a long run can't get SIGKILLed mid-publish and strand a claim. `publishQueueItem`
  dispatches by platform to the existing clients: `facebook` (video → album → photo → text),
  `instagram` (reel → photo), `both` (publishes to both; succeeds if at least one does, so a
  retry can't double-post), `shopify_blog` (`createBlogArticle`). Validated payload contract
  (`parseSocialPayload`/`parseBlogPayload`) and a content_type↔platform pairing guard fail
  loud (→ `markFailed`) instead of posting garbage.
- **`vercel.json`** — hourly cron `"0 * * * *"` for `/api/cron/publisher`.
- `proxy.ts` is unchanged: `/api/cron/publisher` is already public via the existing
  `/api/cron` prefix in `PUBLIC_PATHS` (same as every other cron).
- Known limitation: an item claimed (`publishing`) but not marked before a hard crash/OOM
  stays stranded (no reaper yet — same gap as `claimFacebookDraft`; the time budget removes
  the common timeout cause). Recover with `UPDATE publication_queue SET status='pending'
  WHERE status='publishing'`. A `claimed_at`-based reaper is a follow-up in the queue-engine.
- Tests: `tests/queue-publisher.test.ts` (per-platform dispatch, `both` partial/total
  failure, payload + pairing validation, claim/skip/fail lifecycle, rate-limit spacing,
  budget deferral).

## [0.5.53.58] - 2026-06-15

### Added (social — Approve queues to the publishing schedule)
- **`src/app/api/social/route.ts`** — the `approve` action no longer just marks a
  draft `approved`; it now auto-schedules the draft onto the next free Mon/Wed/Fri
  15:00 UTC publishing slot (`status='scheduled'`, reusing `draft-scheduler`'s
  `langsOf`/`findSlot`/`buildOccupancy` + `getScheduledDraftSlots`). The existing
  `/api/cron/social-scheduled` cron then publishes it when the slot arrives, so
  approval queues rather than publishes immediately. Falls back to `approved` when
  no slot is free within the horizon. Response now returns `scheduledAt`.
- **`src/app/(dashboard)/social/page.tsx`** — Approve shows a `Schedulé pour [date]`
  confirmation, scheduled drafts render a `🕑 Schedulé — [date]` badge (year shown
  when the slot is not in the current year), and the manual **Publish** button is
  disabled for `scheduled` drafts so an operator can't race the cron and double-post.
- **`src/app/(dashboard)/publication-queue-panel.tsx`** (new) — a "File de publication"
  dashboard panel listing the upcoming queued posts; surfaces fetch errors distinctly
  from an empty queue.

## [0.5.53.57] - 2026-06-15

### Added (publication queue — unified scheduling for social / drafts / blog)
- **`src/lib/database.ts`** — new `publication_queue` table (in `initSchema`) plus
  queue functions: `addToQueue`, `getNextPending`, `claimQueueItem`, `markPublished`,
  `markFailed`, `getPendingQueue`, `getOccupiedQueueSlots`. Timestamps are SQLite
  `datetime()` TEXT (`YYYY-MM-DD HH:MM:SS` UTC), distinct from `facebook_drafts`'
  unix-seconds integers, so the `scheduled_at <= datetime('now')` due-scan compares
  lexicographically. Hardening beyond the base spec: `CHECK` constraints on
  `content_type`/`platform`/`status` (a typo'd status would otherwise vanish from every
  status-filtered query); a partial `UNIQUE(platform, scheduled_at)` index over active
  rows as a double-book backstop; `claimQueueItem` (atomic `pending → publishing`) so a
  future consumer cron can't double-publish under Vercel's overlapping cron instances
  (mirrors `claimFacebookDraft`); and `addToQueue` rejects a non-`datetime()` timestamp
  up front since the lexicographic due-check depends on the format.
- **`src/lib/draft-scheduler.ts`** — `toSqliteUtc` (unix → SQLite datetime TEXT),
  `isSqliteUtc` (format guard), and `nextFreeSlot` (next free M/W/F 15:00 UTC slot for a
  platform, as a SQLite datetime string). Pure and unit-tested.
- **`src/app/api/queue/add/route.ts`** — new `POST /api/queue/add` (session auth, blocks
  the `reviewer` role). Validates `content_type`/`platform`/`content_id`/`payload` (with
  size caps), computes the next free slot for the platform, inserts, and returns
  `{ queued: true, scheduled_at }`. On the rare concurrent slot collision it catches the
  unique-index conflict and retries the next slot.
- Tests: `tests/publication-queue.test.ts` (queue SQL semantics, the unique-slot
  backstop, claim atomicity, CHECK enforcement) and additions to
  `tests/draft-scheduler.test.ts` (`toSqliteUtc`/`isSqliteUtc`/`nextFreeSlot`).

## [0.5.53.56] - 2026-06-15

### Fixed (schema init — retry after transient failure, issue #186)
- **`src/lib/database.ts`** — `initSchema()` memoized the promise from
  `_initSchemaImpl()` even when it rejected, so a single transient failure (e.g. a
  flaky `db.batch` during schema build) wedged every later `ensureSchema()` caller on
  the cached rejection until the next cold start. It now attaches
  `.catch(err => { schemaPromise = null; throw err })` so the next caller re-runs
  `_initSchemaImpl()` instead of replaying the cached reject.
- Wrapped the 8 `db.batch()` calls in `_initSchemaImpl()` with a `runBatch(label, stmts)`
  helper that logs the step label + error before re-throwing, so a schema-init failure
  reports which batch broke instead of an opaque stack.

## [0.5.53.55] - 2026-06-15

### Fixed (content cron — diagnosable failures)
- **`src/app/api/cron/content/route.ts`** — when both the FR and EN draft
  generations fail, the cron threw a generic `"Both FR and EN content generations
  failed"` message, which `trackCron` recorded verbatim in `cron_runs.detail`. The
  real per-language cause (`Generation failed (HTTP <status>)` / `Generate endpoint
  unreachable`) stayed buried in Vercel function logs. The thrown message now appends
  each language's actual error (`FR: … | EN: …`), so the dashboard "Résumé du jour"
  panel and the 500 response surface the cause directly. Bounded by design — only the
  short status strings are propagated, never raw response bodies.
- Regression test in `tests/cron-content.test.ts` asserts the both-fail message carries
  each language's error.

## [0.5.53.54] - 2026-06-15

### Added (Meta Ads — multi-copy Advantage+ creative)
- **`scripts/meta-ads-copy-optimization.mjs`** — replaces the creative on the traffic ad
  set (`52562995963805`, campaign `52562992827605`) with a **dynamic (catalogue)**
  `asset_feed_spec` multi-copy creative: **5 primary texts × 5 headlines × 2 descriptions**,
  `SHOP_NOW` → ameublodirect.ca, `ad_formats: AUTOMATIC_FORMAT` with
  `product_set_id 2891699814486850` so Meta pulls the product images from the catalogue
  automatically (no `image_hash` needed) and tests the copy/headline matrix per user.
- Safe-by-design: **dry-run by default** (prints the full payload, asserts 5/5/2); `--apply`
  creates the new creative + ad in **PAUSED** state **first**, then deletes the old ad
  (create-before-delete, so a creative failure can never strand the ad set with zero ads);
  Graph **#190 / token errors STOP** with a "tell Mat" message; logs the created Ad ID to
  `docs/META-ADS-SETUP.md` on apply.

## [0.5.53.53] - 2026-06-14

### Added (Meta traffic campaign tooling)
- **`scripts/meta-traffic-campaign.mjs`** — creates a broad **$5/day Canada FR/EN traffic
  campaign** (campaign → ad set → creative → ad, all **PAUSED**) driving link clicks to
  `ameublodirect.ca` with a dynamic single-image creative from the Business catalog
  `384890002574549`. **Dry-run by default**; `--apply` creates all four objects, idempotent
  by name. Objective mapped to `OUTCOME_TRAFFIC` (ODAX; Meta rejects legacy `LINK_CLICKS` as a
  campaign objective) with ad-set `optimization_goal: LINK_CLICKS`. Ad set targets Canada,
  25–65, broad (Advantage+ audience + automatic placements). Bilingual FR/EN titles +
  descriptions via `asset_feed_spec`, CTA `SHOP_NOW`, page `1057151924144231`. Real creation
  deferred to running `--apply` after the dry-run payloads are validated.

## [0.5.53.52] - 2026-06-14

### Fixed (P0 — production DB unreachable, `/api/health` db:false)
- **`idx_products_has_discount` is now created AFTER the `has_discount` column migration**, not
  in the early `schemaStatements` batch. Since #180, the partial index ran before the
  `ALTER TABLE products ADD COLUMN has_discount` — on the pre-existing prod `products` table the
  column didn't exist yet → `no such column: has_discount` → the whole `initSchema()` write-batch
  threw → `ensureSchema()` rejected (memoized, never retried) → every query failed → `db:false`
  on every deploy since #180. The ALTER was never reached, so the column never got added.
  Moved the `CREATE INDEX IF NOT EXISTS` to a standalone statement after the ALTER (idempotent;
  fresh DBs unaffected). Regression tests added (index throws without the column; succeeds after).
  Turso itself was healthy throughout (raw `SELECT 1` → 200); the fault was schema-init ordering.

## [0.5.53.51] - 2026-06-14

### Fixed (Meta Dynamic Ads — FR ad set on Business catalog)
- **`scripts/meta-ads-create.mjs` (FR profile) now creates a NEW ad set instead of re-pointing.**
  Meta makes an ad set's `promoted_object` immutable (re-point rejected, code 100 / subcode
  1885090), so the FR profile builds a fresh ad set under the existing campaign `52556997335005`,
  cloning the source ad set `52556997397005`'s Canada-FR retargeting targeting + optimization
  (LANDING_PAGE_VIEWS / IMPRESSIONS) + **bid strategy** (`LOWEST_COST_WITHOUT_CAP` — cloning it is
  required or Meta infers one needing a bid_amount, subcode 2490487), at $20/day, with
  `promoted_object = { product_catalog_id: 384890002574549 (Business), product_set_id: 2891699814486850 }`.
  `--apply` creates ad set + creative + ad, all **PAUSED**. The EN from-scratch placeholder path is
  preserved. Verified via dry-run (no API mutation in this PR).

## [0.5.53.50] - 2026-06-14

### Added (pricing floor — never sell below the Aosom CSV price)
- Decision (Mat): sell at exactly the Aosom CSV price (**0% markup**, competitive) but
  **NEVER below it**. The Aosom price is the absolute floor — it protects the ~18%
  Aosom supplier-discount margin (cost ≈ `aosomPrice × 0.82`).
- **`src/lib/pricing.ts`** (new): `targetSellPrice()` is the single pricing rule, floors
  the result at the Aosom price, and returns `NaN` for a missing/≤0 CSV price so callers
  **skip** instead of pushing $0.
- **Job 1 sync** (`diff-engine.ts`): the price target is `targetSellPrice(aosomPrice)`; a
  Shopify price below the floor is force-corrected upward, and price changes are skipped
  when the Aosom price is invalid.
- **Job 3 import** (`createShopifyProduct`): variant price floored the same way (raw-price
  fallback so a bad CSV value can never emit `"NaN"`).
- **`applied_to_shopify` now actually gets set**: `markPriceChangeAppliedBySku(sku, newPrice)`
  flags the matching recorded `price_history` row after each successful push in
  `applyToShopify` (shared by `runSync` + Phase 2 `runShopifyPush`). Matched on SKU **and**
  the pushed price so Phase 2 / floor-only corrections can't flag the wrong row; wrapped in
  its own try/catch so a bookkeeping write can never fail an already-successful price push.
- Tests: pricing (floor + NaN-on-invalid), diff-engine floor (force-up / never-below),
  mark-applied SQL (price-matched, no-op on no match).

## [0.5.53.49] - 2026-06-14

### Fixed (Shopify price-sync starvation — ~428 SKUs were stuck below Aosom cost)
- **`diff-engine.ts`: stop emitting `stock` diffs.** Dropship variants are untracked in
  Shopify (`inventory_management: null`), so `applyToShopify` never pushed stock — yet a
  `stock` diff was generated for ~every product every day. Those unresolvable diffs
  permanently saturated the per-day Phase-2 chunk queue (`SHOPIFY_PUSH_CHUNK_SIZE=10` × 3
  cron slots = 30/day, checkpoint resets daily to the front of a stable-ordered list),
  starving real price/image/description updates in the tail — so Aosom price increases
  recorded since mid-May never reached Shopify and ~428 SKUs sold below cost. Phase 1 still
  records stock movements separately (`detectChanges` → `price_history.stock_change`).
- **`diff-engine.ts`: price-first ordering** in `computeDiffs` so money-affecting
  corrections drain out of the chunk queue before image/description-only diffs.
- **`scripts/fix-prices-reconcile.mjs`** (one-shot, dry-run by default): raises Shopify
  variant prices that are below `products.price` (Aosom cost) up to cost; only ever raises
  (never lowers, preserving manual markup); strict 2 req/sec; logs each write. Executed
  2026-06-14: **428 corrected, 0 failed**.

## [0.5.53.48] - 2026-06-14

### Added (price-floor monitoring)
- **`GET /api/health/price-audit`** (CRON_SECRET) — compares the live Shopify price of every
  variant against `products.price` (the Aosom feed price = floor) and returns
  `{ total, below_floor, items: [{ sku, shopify_price, aosom_price, gap }] }` (gap = shopify −
  aosom; negative = below floor). Pure `computePriceFloorViolations()` (cents-rounded, exact-match
  counts as at-floor, not below) with 6 unit tests. `maxDuration` 300s.
- **Dashboard red alert** in the "Alertes" panel when `below_floor > 0`, showing the worst items.
  The endpoint persists a compact summary to `settings.price_audit_result`; the dashboard reads
  that cached row (`getDashboardAlerts`) — the expensive Shopify fetch never runs on dashboard load.
- **Daily Vercel cron** at 09:30 UTC (after the morning sync + Shopify price push) so the alert
  stays current.
- First live run: **428 of 1058** live Shopify variants are currently priced below the Aosom floor.

## [0.5.53.47] - 2026-06-14

### Performance (Turso reads — has_discount precompute + cron/feed retention)
Consolidates the only pieces still missing from `main` out of the (now-closed) stale PRs
#170 + #171; the `sync_logs`/`notifications`/`price_history` purges already landed via #172.
- **Precomputed `products.has_discount` flag** (+ partial index `idx_products_has_discount
  ... WHERE has_discount = 1`). `getCatalogStats` and the "Avec rabais" filter now read the
  cheap indexed flag instead of a correlated `EXISTS` over `price_history` on every page
  load. Recomputed once/day at sync finalize (`recomputeHasDiscount`) via the canonical
  `PRODUCT_HAS_DISCOUNT_SQL` predicate (single source of truth shared with the ▼ badge, so
  count/filter/badge stay consistent). One-time backfill in the schema migration.
- **`cron_runs` + `feed_syncs` retention** (`purgeOldCronRuns(30)` / `purgeOldFeedSyncs(30)`
  at sync finalize). `cron_runs` grows ~96 rows/day from `social-scheduled` alone; the
  dashboard only reads the latest run per name/feed. 30-day window can't orphan those rows
  (every cron runs at least daily).

## [0.5.53.46] - 2026-06-14

### Added (Klaviyo Welcome coupon — BIENVENUE10)
- **`scripts/shopify-create-discount.mjs`** — creates the `BIENVENUE10` welcome discount in
  Shopify (10% off, `once_per_customer`, no expiry). Dry-run by default; `--apply` creates it,
  idempotent (skips if the code already exists). Needs the token's `write_discounts` scope.
- **Created live (2026-06-14):** price rule `1916108374121`, discount code `17247691178089`
  (`BIENVENUE10`). Verified: `value -10.0` percentage, `once_per_customer: true`,
  `usage_limit: null`, `ends_at: null`.
- **Docs:** `docs/KLAVIYO-FLOWS.md` records the IDs + the remaining manual steps (insert the code
  into the Welcome email, flip the 4 flows `draft → live` after the pre-launch checklist). Klaviyo
  flow activation stays a dashboard/human action (no `KLAVIYO_API_KEY` in this env, and the
  Cart/Price-Drop emails still need dynamic blocks before going live).

## [0.5.53.45] - 2026-06-14

### Docs
- Added `docs/site-health-report.md` — full read-only production health check (2026-06-14):
  storefront live + new theme active (hero/title/og/meta/0 Liquid errors), 4/4 feeds HTTP 200
  (1064 products each), « Voyez-le chez vous » page (15 `<video>`), 16 `video_ingest_log` rows
  `READY`, Turso responding (11 205 products). **8/8 checks ✅.** No site/data mutations.

## [0.5.53.44] - 2026-06-14

### Fixed (blog cron blocked by auth middleware)
- **Allowlist `/api/blog` in `src/proxy.ts` `PUBLIC_PATHS`.** The blog cron does a
  server-to-server `fetch` to `/api/blog/generate` with `Authorization: Bearer CRON_SECRET`
  and no session cookie. The middleware ran first, ignored the Bearer header, and
  307-redirected the POST to `/login` → 405 → both FR and EN sub-calls failed →
  `"Both FR and EN blog generations failed"` in `cron_runs` (last success 2026-06-09).
  The route already self-gates on CRON_SECRET + session (auth-first, returns 401 for
  unauthenticated requests), exactly like the already-allowlisted `/api/social/content`,
  so making the prefix public exposes nothing — it just lets the cron's request reach the route.

## [0.5.53.43] - 2026-06-14

### Meta Dynamic Ads — activation attempt (blocked upstream) + EN profile
- Ran `scripts/meta-ads-create.mjs --apply` to create the FR Dynamic Ad. **Meta rejected it**
  (`code 10 / subcode 3379015`): the ad set's catalog `1103064966519153` is a *personal*
  Marketplace catalog, which cannot run ads. **No creative/ad was created** — an upstream
  configuration blocker, not a code bug.
- **Script:** added a catalog ads-eligibility **preflight** (fails fast with the remediation
  instead of a raw 400) and a `--profile en` path for Furnish Direct (EN). EN dry-run validated
  (campaign + ad set don't exist yet, so it prints the full structure to create + the EN
  creative/ad payloads). EN held for validation — dry-run only.
- **Docs:** `docs/META-ADS-SETUP.md` documents the blocker, the ads-eligible Business catalog
  `384890002574549` (only 5 products synced — needs the Shopify→Meta sync completed), the exact
  remediation (re-point the ad set to the Business catalog, then re-run `--apply`), and the EN plan.

## [0.5.53.42] - 2026-06-14

### Fixed (ops tooling)
- **`scripts/verify-live-storefront.mjs` — hero/title checks now match the real live HTML.** The
  hero assertion used a plain-accent literal (`Meublez votre espace à votre image`) that never
  matched: the live theme emits the accent as the HTML entity `&agrave;` with a trailing period,
  and the page has a hidden a11y `<h1>` before the hero. The check now decodes HTML entities and
  substring-matches, and additionally asserts the real `<title>`
  (`Ameublo Direct | Meubles et mobiliers extérieurs`). All 6 checks pass against
  https://ameublodirect.ca/.

### Docs
- `docs/DATA-OPS-LOG.md`: recorded the 2026-06-14 theme publish op — the preview→live swap was
  found **already applied** (preview `160213696617` already `role:main`), so no publish was
  performed; the script's abort gate correctly refused. Includes the read-only storefront
  verification.

## [0.5.53.41] - 2026-06-14

### Added (Meta Dynamic Ads activation)
- **`scripts/meta-ads-create.mjs`** — creates the missing Ad Creative + Ad for the (PAUSED)
  retargeting campaign so it becomes operational. **Dry-run by default** (lists current state
  and prints the exact creative/ad payloads, sends nothing); `--apply` creates both as PAUSED
  and is idempotent by name (reuses an existing creative, skips a duplicate ad). Verified live
  against the Graph API v21.0: ad set `52556997397005` → campaign `52556997335005`, catalog
  `1103064966519153`, product set `1718195966267686` (1000 products); no existing catalog
  creative or ad on the ad set. Real ad creation is deferred to running `--apply` after the
  payloads are validated.

### Security (/cso audit — daily, 8/10 gate)
- Ran `/cso` over the current tree + recent Turso-quota merges. **No open P0/P1.** Appended a
  dated run entry to `docs/SECURITY-BACKLOG.md`: secrets clean (`.env*` gitignored, scripts use
  env), SQL fully parameterized (dynamic UPDATEs use column allowlists), `src/proxy.ts` is the
  correctly-wired Next 16 `proxy` middleware (centralized auth resolves the old P2-1). Prior
  P2/P3 items re-confirmed; none exploitable today.

## [0.5.53.40] - 2026-06-14

### Chore (ops tooling)
- Added three standalone theme-publication ops scripts under `scripts/` (recreated from a sibling
  clone where they had only ever existed as untracked working-tree files, never committed):
  - `themes-list.mjs` — read-only theme list + pre-publish gate check (preview/live id + name + role).
  - `publish-preview-live.mjs` — publish the preview theme to live (`role:main`) with an abort gate
    on unexpected state and a post-publish swap confirmation.
  - `verify-live-storefront.mjs` — fetch the live storefront and assert hero title / og:image /
    meta description / no Liquid errors / video section present.
- No application code touched; scripts are run manually via Node. Two reuse the existing
  `scripts/_shopify-lib.mjs` REST helper.

## [0.5.53.39] - 2026-06-14

### Fixed (Turso row-quota — sync_logs + notifications retention)
- **Auto-purge `sync_logs` (7 days)** added to the daily sync finalize via `purgeOldSyncLogs(7)`.
  `sync_logs` grows one row per changed field per sync (~10k rows after weeks); the history UI only
  reads recent runs. `sync_logs.timestamp` is an ISO-8601 TEXT string (not an epoch column), so the
  retention parses it with `unixepoch(timestamp)` for a correct numeric comparison.
- **Auto-purge `notifications` (30 days)** added via `purgeOldNotifications(30)`. Transient dashboard
  alerts regenerated each sync; `created_at` is epoch seconds (uses the existing index). Purges read
  and unread alike (age-based).
- Both purges run in their own non-fatal try/catch in `runSyncFinalize`, mirroring
  `purgeOldPriceHistory` — a purge failure never fails an otherwise-successful sync. Retention-SQL
  tests added for both, including NULL/unparseable-timestamp safety and read/unread parity.

### Docs
- Documented the `AUTH_PASSWORD` fallback login (PR #167) in `docs/TURSO-UPGRADE.md` §7, including the
  **action item for Mat to add `AUTH_PASSWORD` to Vercel env vars** (Production + Preview) so the
  Turso-independent admin login works in prod. `.env.local` / `.env.example` already carry it.

## [0.5.53.38] - 2026-06-14

### Fixed (Turso row-quota purge + auto-purge retention)
- **Daily auto-purge tightened 90d → 30d:** `runSyncFinalize` (`src/jobs/job1-sync.ts`) now calls
  `purgeOldPriceHistory(30)`. The 90-day window never fired while `price_history` data spanned
  <90 days, letting the table reach 242k+ rows and breach the Turso row quota. The guarded purge
  keeps each SKU's latest `price_drop`/`price_increase` row regardless of age, so the "Avec rabais"
  badge (`PRODUCT_HAS_DISCOUNT_SQL`) is preserved.
- **One-time manual purge (2026-06-14):** atomic transaction deleted 104,497 aged `price_history`
  rows (242,695 → 138,198) plus 24 published `facebook_drafts` >30d. Full audit trail in
  `docs/DATA-OPS-LOG.md`, including the accepted side-effect on the internal catalog "Avec rabais"
  filter (not customer-facing; self-heals on next price change).
- **Ops scripts** (read-only audit + dry-run + guarded apply): `scripts/turso-purge-audit.mjs`,
  `scripts/turso-purge-dryrun.mjs`, `scripts/turso-purge-apply.mjs`. The apply script mirrors the
  production retention guard so a re-run cannot over-delete latest-per-SKU price-change rows.

## [0.5.53.37] - 2026-06-14

### Performance (Turso row-read reduction)
- **Composite indexes** added in `ensureSchema()`:
  - `price_history(sku, detected_at)` — accelerates the correlated "Avec rabais" subquery
    (`PRODUCT_HAS_DISCOUNT_SQL`) and the `last_price` CTE; EXPLAIN QUERY PLAN confirms the
    temp-b-tree sort is eliminated. This is the #1 catalog read-cost path.
  - `price_history(change_type, detected_at)` — covering index for the dashboard new-product
    count and the best_sellers/price_drop aggregates.
  - `facebook_drafts(status, created_at)` — serves the drafts review list (status filter +
    `ORDER BY created_at`) and the dashboard stale-draft scan. (Chose `created_at` over
    `trigger_type`: the planner only seeks `status` and post-filters `trigger_type`, so a
    `(status, trigger_type)` index would add write cost with no read benefit.)
- **Dashboard metrics cache:** `getDashboardSummary` / `getDashboardAlerts` now use a 5-minute
  in-memory TTL cache, gated to production (Turso) so local/tests stay uncached. Cuts repeated
  COUNT/aggregate reads when the dashboard is polled. `clearMetricsCache()` exposed for tests.
- Audited the other index candidates (`shopify_product_id`, `sku` PK, `cron_runs`, `feed_syncs`,
  `video_jobs.status`) — already indexed, not re-added. `getProducts()` already selects only
  catalog columns (no heavy `description`/`body_html`), so no SELECT trimming was needed.

## [0.5.53.36] - 2026-06-14

### Fixed (P0 — Turso quota + dashboard login lockout)
- **DB-independent emergency admin login** (`src/app/api/auth/route.ts`): when Turso is blocked
  (monthly row-read quota exceeded) or down, `getUserByUsername()` threw and *nobody* could log
  into the dashboard. Added a fallback that verifies the submitted password against `AUTH_PASSWORD`
  with a constant-time compare and issues an admin session **without any DB query** — runs before
  `ensureSeededUsers()` so an outage never even attempts a query on this path. Restricted to
  username `admin`; rate-limited; non-string JSON inputs now coerced (no more opaque 500s).
- **CDN cache on `GET /api/catalog/stats`** (`s-maxage=600`): the "Avec rabais" count is a
  correlated subquery over `price_history` (one pass per product, ~11k rows) that ran on every
  catalog page mount, uncached. Caching it cuts Turso row-reads on this route ~144×/day.
- **`price_history` retention** (`purgeOldPriceHistory`, called at the end of the daily sync):
  deletes rows older than 90 days to cap storage + discount-query read cost. Keeps each SKU's
  *latest* price-change row so a still-on-sale product (last drop >90 days ago) never silently
  loses its rabais badge / "Avec rabais" count.
- Diagnostic + Turso plan/upgrade analysis documented in `docs/TURSO-UPGRADE.md`.

## [0.5.53.35] - 2026-06-11

### Changed (home video section — mobile horizontal swipe carousel)
- **Mobile (<750px):** the stacked vertical grid of "Voyez-le chez vous" is now a horizontal
  swipe carousel on `sections/home-video-showcase.liquid` (preview theme `160213696617`).
  `display:flex; overflow-x:scroll; scroll-snap-type:x mandatory; scroll-snap-align:start`,
  cards `flex:0 0 80vw` (max 320px) so the next card's edge peeks to invite swiping, scrollbar
  hidden (Firefox `scrollbar-width:none` + webkit `::-webkit-scrollbar`), iOS momentum scroll.
  All 6 cards reachable by swipe; overlay (title/price) always visible. Frees vertical space.
- **Desktop (≥750px):** unchanged — 4-column grid, hover-to-play, cards 5-6 hidden, IO/hover JS
  branch untouched. Live theme (`160059195497`) not touched.
- Adds `scripts/apply-video-horizontal-scroll.mjs` (guarded string-replace apply, preview-only)
  and `scripts/verify-video-horizontal-scroll.mjs` (14 checks). QA: mobile 390 + desktop 1280
  in headless Chromium, 0 bugs, health 100.

## [0.5.53.34] - 2026-06-11

### Security (Voyez-le page — generator hardening)
- **`scripts/apply-voyez-le-page.mjs`**: validate `handle` (`^[a-z0-9-]+$`) and the source
  `video_url` (https Aosom-CDN `.mp4`, no quote/bracket/space chars) before baking them into
  the generated Liquid, and HTML-escape the `data-src` / `data-cat` attribute values. Closes
  a markup/Liquid-injection path where a malformed Turso `video_url` could break out of the
  `<source data-src="…">` attribute on the generated section. Re-ran the generator on PREVIEW
  theme 160213696617 (15 published cards) — live theme untouched. Follow-up hardening on the
  page shipped in #160.

## [0.5.53.33] - 2026-06-11

### Added (preview readiness audit)
- **`docs/preview-ready-checklist.md`.** Read-only audit of preview theme `160213696617`
  (homepage / page "Voyez-le chez vous" / PDP) via Shopify Admin API. Verdict: **PRÊT À PUBLIER**,
  aucun écart bloquant; 3 items signalés pour confirmation visuelle manuelle (provenance Unsplash
  des tuiles, compte exact des swatches couleur côté app, dernier coup d'œil liquid runtime au
  storefront preview). Live (`160059195497`) non touché.
- **`scripts/preview-ready-audit.mjs` / `preview-audit-pdp.mjs` / `preview-audit-tiles.mjs`.**
  Scripts d'audit en lecture seule (GET assets/pages + une requête GraphQL menus) qui produisent
  le checklist : position de la section vidéo, gate hover desktop, autoplay mobile, méga-menu,
  tuiles, why_us, mentions livraison, page Voyez-le, et blocs PDP (eyebrow / Judge.me / ATC navy /
  cross-sell / swatches bilingues).

### Tooling
- Mise à jour gstack `1.57.6.0 → 1.57.10.0` (global, hors dépôt). `/review` `/qa` `/ship` `/cso`
  vérifiés au chargement post-MAJ.

## [0.5.53.32] - 2026-06-11

### Fixed (Aosom video — product 7793455792233 / SKU 84B-146BU)
- **Re-ingested the 84B-146BU product video.** Force-replaced the existing READY media
  (`gid://shopify/Video/39506307907689`) with a fresh upload from the Turso `products.video`
  URL via the validated pipeline (stagedUploadsCreate → GCS upload → productCreateMedia →
  poll READY). New media `gid://shopify/Video/39508139671657` is READY on the live product;
  `video_ingest_log` upserted.

### Added (tooling)
- **`scripts/reingest-84B146BU.mjs`** — single-SKU force re-ingest. Uploads + attaches the
  new video and polls READY **before** deleting the prior media, so a mid-pipeline failure
  can never strand the live product with no video. Download/upload timeouts, a `gql()` data
  guard, and timeout-state logging were added under `/review`.

### Security (/cso daily audit, 8/10 gate)
- No P0/P1. Auth/proxy, 9 cron-secret gates, SQL builders, the SSRF guard, CI, and secrets
  verified clean. `bun audit`: 6 moderate / 0 high-critical, none reachable. Appended
  **P3-8** (bump dompurify/ws) and **P3-9** (operator-script SSRF parity note) to
  `docs/SECURITY-BACKLOG.md`.

## [0.5.53.31] - 2026-06-11

### Fixed (home video section — preview theme 160213696617)
- **Repositioned "Voyez-le chez vous"** (`home-video-showcase`) above the product carousels:
  now directly after `shop_pay_home`, before `featured_sale` / `featured_collection2` in
  `templates/index.json`. Higher visibility for the video gallery on the homepage.
- **Desktop perf fix (≥750px):** static product poster, MP4 loads + plays on hover/focus only
  (`preload="none"`, no upfront fetch); 4 of 6 cards shown in a single row. Eliminates the
  upfront download of multiple videos on desktop page load.
- **Playback gated on input capability, not viewport width** (`(hover:hover) and (pointer:fine)`):
  touch tablets ≥750px now autoplay via IntersectionObserver instead of being stuck on a hover
  that never fires (review finding). Mobile (<750px) unchanged: all 6 cards, lazy autoplay.

### Added (deploy + QA tooling)
- **`scripts/apply-video-section-fix.mjs`** — guarded apply (preview-only; live theme aborted) of the
  section + index reorder.
- **`scripts/verify-video-section-fix.mjs`** — 14 structural checks against the live preview asset.
- **`scripts/qa-render-harness.mjs`** — builds a standalone browser harness from the deployed asset to
  exercise the desktop/tablet/phone branches in headless Chromium (4 scenarios, 0 bugs).
- **`scripts/inspect-video-state.mjs`** / **`scripts/dump-video-section.mjs`** — read-only inspection helpers.

## [0.5.53.30] - 2026-06-11

### Added (batch video ingest — top-30)
- **`scripts/aosom-video-ingest-batch.mjs`.** Batch sibling of the single-product ingest: attaches
  each top-30 SKU's `products.video` Aosom MP4 to its Shopify product as VIDEO media via
  `stagedUploadsCreate(VIDEO)` → multipart POST to the staged GCS target → `productCreateMedia` →
  poll `status` to `READY`. Throttled to ≤2 Shopify req/s. `--dry-run` (default) lists candidates;
  `--apply` executes. Idempotent on three layers: `video_ingest_log` `READY` skip, in-run
  sibling-product dedup (one product carries one video), and a Shopify-side existing-`READY`-video
  skip. Logs every outcome to Turso `video_ingest_log` (matches the live schema, adds a nullable
  `error` column; atomic delete-then-insert upsert).
- **Applied (live):** 17 SKUs with a video URL → 14 unique products. **12 ingested / 5 skipped / 0
  errors** (3 sibling pairs deduped + the 3 already-validated test products). All 14 products now
  carry exactly one `READY` video. Note: these products are currently unpublished to the Online
  Store, so the videos render once each is published. See `docs/DATA-OPS-LOG.md` (2026-06-11).

## [0.5.53.29] - 2026-06-12

### Added (video ingest 2+3) / Security (SSRF P2-6 fix)
- **C1 — Aosom video ingest for the other 2 test products** (`apply-video-ingest.mjs`,
  Mat-authorized): `01-0893` + `120307-025` ingested (staged → multipart POST to GCS 204 →
  productCreateMedia → **READY**), logged to Turso `video_ingest_log`. Idempotent — `01-0415`
  skipped (already has a video). **Final: 3/3 READY.** Pipeline validated end-to-end.
- **C2 — SSRF P2-6 fixed** (`classifyImageBackground`): now calls `assertPublicHttpsUrl(new
  URL(url))` before the fetch and uses `redirect: "error"` (no auto-follow into internal
  hosts); any violation → `"unknown"` failsafe. The guard was extracted to a dependency-free
  `src/lib/url-safety.ts` (re-exported from `image-composer.ts`) so `variant-merger` doesn't
  pull the config/sharp graph. Unit-tested (http/localhost/127.*/169.254.*/10.*/malformed all
  → `"unknown"`, network never hit). Marked **RESOLVED** in `docs/SECURITY-BACKLOG.md`.
- `tsc` clean, **774 tests** green.

## [0.5.53.28] - 2026-06-12

### Changed / Added (swatches + EN parity on PREVIEW; first real video ingest)
- **C1 — full FR+EN swatch map** (`apply-swatches-full.mjs`, PUT 200): replaced the PDP swatch
  color map in `main-product.liquid` with the complete 69-entry FR+EN map (gris clair, bleu
  ciel, sauge, lavande, violet, bambou, rotin, acier, bronze, cuivre, lin, mixte gradient, …).
- **C2 — EN parity featured_sale + cross-sell** (`apply-en-parity.mjs`, 3× PUT 200): these are
  user-set native section values (NOT localizable via locale files / public Translations API),
  so true bilingual rendering was added in the section liquids — `related-products.liquid`
  heading → "You might also like", `featured-collection.liquid` sale subtitle → "Unbeatable
  prices on our favourite picks." (both gated on the FR text so other instances are
  unaffected). The requested `locales/en.default.json` keys were added too (inert for user
  values; documented).
- **C3 — first REAL Aosom video ingest** (`apply-video-ingest-1.mjs`, Mat-authorized test on
  **1 product only**): full pipeline validated — stagedUploadsCreate(VIDEO) → 3.5 MB multipart
  POST to GCS (204) → productCreateMedia → polled **READY** (15 s) → logged to Turso
  `video_ingest_log`. Product `01-0415` (gid 7798393897065). httpMethod is POST (GCS policy
  form), not PUT. Idempotent (skips if the product already has a video). **The other 2 products
  await Mat's validation.** `tsc` clean, 773 tests green.

## [0.5.53.27] - 2026-06-11

### Security (docs-only — `/cso` daily audit, no code change)
- **`/cso` audit (code surface since 2026-06-08, PRs #149–#155).** Appended a dated entry to
  `docs/SECURITY-BACKLOG.md`. One new **P2-6**: `classifyImageBackground`
  (`variant-merger.ts:289`) fetches product image URLs with a raw `fetch` and no SSRF guard —
  no HTTPS enforcement, no internal-host denylist, default auto-follow redirects — unlike the
  hardened `downloadImage`/`assertPublicHttpsUrl` path. Rated P2 (blind, GET-only,
  supplier-feed source). Fix noted in the backlog (reuse `assertPublicHttpsUrl` + manual
  redirects). Verified clean: `stripLeadingHeading` regex (no ReDoS), `/api/video-serve`
  (id-validated, DB-controlled paths), `/api/catalog/stats` (middleware-gated, counts only),
  secret scan.

## [0.5.53.26] - 2026-06-12

### Changed (PREVIEW theme `160213696617` + preview-only menu — live untouched)
- **Enfants mega-menu.** Uploaded 2 Unsplash assets (`cat-enfants-furniture.jpg`,
  `cat-enfants-toys.jpg`) for the Enfants mega cards and repointed the **Enfants parent → the
  unified `enfants` collection** (37 products) via `menuUpdate` on `preview-main-menu` (children
  Jouets/Meubles preserved). Kept dedicated collections rather than `?type=` filters (the
  collection's product types are Google-taxonomy strings, and the mega resolves images by handle).
- **PDP color swatches.** `sections/main-product.liquid` now renders the "Couleur"/"Color"
  variant option as round color swatches (name→hex map FR/EN, partial-match fallback); the
  selected swatch gets a gold `#D4A853` ring. Non-color options keep text buttons. Layered on
  Dawn's picker (no snippet change). QA `scripts/verify-enfants-swatches.mjs`: 10 ✅.

## [0.5.53.25] - 2026-06-11

### Changed (Phase 6 — voice + cross-sell + final audit, PREVIEW `160213696617` only)
- **C1 — Québécois voice on the homepage** (`apply-phase6-voice.mjs`, PUT 200): `featured_sale`
  subtitle "Des prix imbattables sur nos coups de cœur du moment."; `why_us` 4 warmer titles
  (incl. "On est d'ici. On vous répond en français."); `shop_pay` naturalness tweaks
  ("Aucun intérêt", "Approbation instantanée"); announcement bar → "Livraison gratuite au
  Canada · Retours 30 jours · Paiement sécurisé".
- **C2 — curated PDP cross-sell** (`apply-phase6-crosssell.mjs`, PUT 200): the existing
  `related-products` section (Shopify category recommendations + card-product) re-titled
  **"Vous aimerez aussi"**, limited to **4** products. (Config lives in `product.json`, not
  `main-product.liquid`; sold-out moot under dropship.)
- **C3 — final theme audit** (`verify-final-audit.mjs` → `docs/final-theme-audit.md`):
  **18 ✅ / 0 ❌**. Verdict **PRÊT À PUBLIER**, with 2 non-blocking follow-ups (FR color
  swatch config to confirm; EN parity on 2 native settings).
- EN note: `featured_sale` subtitle + `related-products` heading are native monolingual
  settings (FR shown); a theme translation would localize them.

## [0.5.53.24] - 2026-06-11

### Added / Changed (C3 — leading-heading strip + on-push guard)
- **On-push guard.** New pure `src/lib/html-utils.ts` `stripLeadingHeading()` removes a single
  leading `<h1>/<h2>/<h3>` from a description (idempotent, only the first element). Wired into
  `shopify-client.ts` so **new imports** never reintroduce the "duplicate title" marketing
  heading. Tested: `tests/html-utils.test.ts` (8 cases).
- **Backfill applied.** `scripts/apply-strip-h2.mts` (reuses the same helper) stripped the
  leading heading on **26/26** affected products via `productUpdate` (2 req/s, idempotent;
  re-run = 0). Many removed headings also carried the brand (Aosom/Outsunny/Qaba), now gone.
- `tsc` clean, **773 tests** green (765 + 8 new).

## [0.5.53.23] - 2026-06-11

### Added (PREVIEW theme `160213696617` only — live untouched)
- **Home "Voyez-le chez vous" video section.** New `sections/home-video-showcase.liquid`: a
  responsive grid (3/2/1) of **6** product videos (Aosom MP4s) on `#FAFAF8` with navy DM Sans
  titles. Each card autoplays muted/looped **only when scrolled into view** (IntersectionObserver
  + `preload="none"`, so no MP4 downloads on initial load), shows a poster + a navy hover overlay
  with the live title/price (`all_products[handle]`), and links to the product. Added to
  `index.json` after the carousels. The 6 products were filtered to active+published. QA
  `scripts/verify-home-video.mjs`: 10 ✅.
- **`docs/pagespeed-audit.md`** — read-only home perf audit: healthy (0 render-blocking JS, DM
  Sans loaded + preloaded, 102/121 images lazy); refinements flagged (width/height on 6 images,
  lazy on 18 more, trim ~45 KB inline JS).

## [0.5.53.22] - 2026-06-11

### Added (3 data dry-runs — read-only, no writes)
- **C1 — collection match counts** (`scripts/collections-match-dry-run.mjs`): tested the 4
  proposed smart-collection rules against all 502 products. Électronique **18** (mostly
  electric ride-on toys), Décoration **25** (mixes outdoor lighting), Jardin **195** (too
  broad), Enfants **37** (cleanest). No collection created.
- **C2 — EN-title parity** (`scripts/en-titles-parity-dry-run.mjs`): the 7 A1-cleaned products
  still carry the brand in their **EN** titles (6 Translations API, 1 `custom.title_en`
  metafield). **7/7 would change**; before/after reported. No writes.
- **C3 — P0 remediation audit** (`scripts/p0-remediation-audit.mjs`): leading marketing
  heading in `body_html` still present on **26/502** active products (the "duplicate title"
  culprit — a **data** fix, not CSS; some headings repeat the brand); `##` markdown **0/502**;
  the draft "2 H1" is the draft→home redirect, **not a PDP bug** (5 drafts; published PDPs = 1
  H1). No security P0/P1 outstanding.
- Report: `docs/data-chantiers-dry-run.md`. `tsc` clean, 765 tests green. All apply steps
  await Mat's validation.

## [0.5.53.21] - 2026-06-11

### Changed (uniform mega-menu + hero buttons — PREVIEW `160213696617` only, live untouched)
- **Catalog-fit uniform mega-menu.** A collection audit showed the store can't support a
  4-card mega for all 8 proposed categories — **no electronics** (0 collections), and
  Déco/Jardin/Enfants lack dedicated collections. Per Mat's decision (catalog-fit): image
  mega-menus for **Mobilier extérieur (4) · Meubles (4) · Animaux (3) · Enfants (2)**;
  **Rabais 🔥 · Jardin · Coups de cœur · Catalogue** as direct links; **Électronique + Déco
  dropped**. `snippets/mega-menu.liquid` now carries **13 image cards** (Unsplash, navy
  overlay `rgba(27,42,74,.34)`, DM Sans Bold, hover `scale(1.02)`); `header-mega-menu.liquid`
  delegates to it. Separate `preview-main-menu` (menuUpdate); live `main-menu` untouched.
  Script: `apply-menu-uniform-preview.mjs` (idempotent, self-contained).
- **Hero buttons visibility fix** (`lc_hero`): primary = solid navy `#1B2A4A` + gold border;
  secondary = semi-transparent white + navy text + gold border; title/subtitle `text-shadow`;
  bottom gradient overlay (transparent → `rgba(0,0,0,.45)`) + button drop-shadow so the CTAs
  stand out against the photo. Script: `apply-hero-buttons-preview.mjs`.
- **Verification** (`verify-menu-uniform-preview.mjs`): **23 ✅ / 0 ❌** (incl. live
  `main-menu` untouched + liquid tag-balance sanity on both edited snippets).

## [0.5.53.20] - 2026-06-11

### Changed (PREVIEW theme `160213696617` only — live untouched)
- **Phase 4 — PDP redesign.** `sections/main-product.liquid`: added a category **eyebrow**
  (`product.type`, navy uppercase DM Sans) above the H1, the **Judge.me preview badge under the
  H1** (metafield-badge placement), and a **navy `#1B2A4A` ATC button** (radius 4px, hover
  lighter, full-width on mobile). `snippets/price.liquid`: shows **"Économisez X$" only when the
  discount ≥ 10 %**. `templates/product.json` `trust_badges`: under-ATC reassurance converted
  from emoji (🚚🔄🔒⭐) to **navy thin-line SVG** (Livraison gratuite · Retours 30 j · Paiement
  sécurisé · Service québécois). Gallery unchanged (media[0] already featured). QA
  `scripts/verify-pdp-redesign.mjs`: 8 ✅.

## [0.5.53.19] - 2026-06-11

### Docs
- **Pre-publish audit checklist (read-only, no writes).** `docs/pre-publish-checklist.md`
  compares the preview theme `160213696617` against the live `160059195497` and checks SEO,
  home content, performance, and theme security before publishing. Verdict: **publish-ready**,
  26 ✅ / 3 ⚠️ / 0 ❌. The ⚠️ items: confirm the preview render has no liquid error via admin
  Theme → Preview; confirm the Meta Pixel (absent from `theme.liquid` + rendered HTML — may be
  a sandboxed Web Pixel via the Facebook app); plus notes on `preview-main-menu` and the popup
  10% code (Klaviyo flow). Scripts: `scripts/pre-publish-audit.mjs`, `pre-publish-followup.mjs`.

## [0.5.53.18] - 2026-06-11

### Added (PREVIEW theme `160213696617` only — live untouched)
- **First-order discount popup.** New `entry_popup` custom-liquid section: a discreet 10%-off
  email capture (navy/gold DM Sans, FR/EN), opens after 5 s OR 50 % scroll, once per visitor
  (`localStorage`), with close ×/overlay/Esc, mobile-friendly. Email submits via a plain
  Shopify `form_type=customer` newsletter form (→ Klaviyo), not `/api/price-alert`. The 10%
  code itself is delivered by the Klaviyo Welcome flow (attach a discount code there).

### Changed (PREVIEW)
- **"Pourquoi nous choisir" (`why_us`) premium.** 4 distinct points with navy thin-line SVG
  icons on `#FAFAF8`: Catalogue 490+ produits · Livraison gratuite au Canada · Retours faciles
  30 jours · Service client québécois. The reassurance "livraison gratuite" now lives here once.
- **Reduced repetition / polish.** Dropped the "Livraison gratuite" span from `lc_trustbar`
  (home "livraison gratuite" = 2: announcement bar + why_us). Removed the redundant all-caps
  `rich_text` strip. Stripped the 🔥 from the "Meilleures offres du moment" heading.

### Added
- **`docs/preview-final-audit.md`** — read-only audit (livraison/emojis/CAPS/redundancy). QA
  `scripts/verify-polish-final.mjs`: 8 ✅. Scripts under `scripts/*polish*` (preview-guarded).

## [0.5.53.17] - 2026-06-11

### Changed (navigation + hero premium — PREVIEW theme `160213696617` only, live untouched)
- **Premium navigation with image mega-menu.** The shared `main-menu` is store-wide (editing
  it would change the live storefront), so a **separate `preview-main-menu`** was created and
  only the preview theme's header repointed at it (live keeps `main-menu`). New top categories:
  **Rabais 🔥 · Mobilier extérieur · Meubles · Jardin · Animaux · Déco · Catalogue**. New
  `snippets/mega-menu.liquid` renders image cards (8 Unsplash photos keyed by the collection
  handle in each link's URL, navy `#1B2A4A` / gold `#C17F3E`, DM Sans) for the two mega items
  (Mobilier extérieur, Meubles, 4 sub-categories each → existing collections);
  `snippets/header-mega-menu.liquid` now delegates the mega panel to it. Sticky header already
  on (`reduce-logo-size`). Scripts: `apply-nav-preview.mjs`, idempotent.
- **Hero refonte** (`templates/index.json` `lc_hero`): headline → "Meublez votre espace à
  votre image.", subtitle → "Mobilier moderne, livraison gratuite partout au Canada.", two
  CTAs (navy primary "Magasinez maintenant" → /collections/all; outline-gold secondary "Voir
  les rabais" → /collections/rabais), and a floating badge "⭐ Service québécois · Retours 30
  jours". Existing `lc-hero.jpg` kept. Bilingual FR/EN. Script: `apply-hero-preview.mjs`.
- **Verification** (`verify-nav-hero-preview.mjs`): **17 ✅ / 0 ❌** (incl. live `main-menu`
  confirmed untouched).
- **Flag:** no dedicated "Déco" collection exists — "Déco" currently points to
  `meubles-et-decorations` (same as Meubles). Mat to create/curate a real Déco collection if
  he wants it distinct.

## [0.5.53.16] - 2026-06-11

### Changed (PREVIEW theme `160213696617` only — live untouched)
- **Homepage premium — shipping mentions.** Reduced "livraison gratuite" on the home from 4
  to 2 (kept announcement bar + `lc_trustbar`). Replaced `lc_hero` H1 ("Livraison gratuite au
  Canada" → "Satisfaction garantie 30 jours") and the `why_us` truck icon ("Livraison gratuite"
  → "Plus de 490 produits").
- **Homepage premium — category tiles.** Replaced the native `collection_list` ("Magasinez par
  catégorie", 6 plain cards) with a `cat_tiles` custom-liquid grid: Unsplash lifestyle
  backgrounds (uploaded as `assets/cat-tile-1..6.jpg`), navy `#1B2A4A` 50% overlay, white DM
  Sans Bold bilingual titles, hover `scale(1.02)` + lighter overlay, responsive 3×2 / 2-col.

### Added
- **`docs/homepage-audit.md`** — read-only audit (sections/order, navigation, "livraison"
  occurrences, category buttons) produced before any change. QA: `scripts/verify-premium.mjs`
  all ✅. Scripts under `scripts/*premium*`, `homepage-audit.mjs` (preview-guarded).

## [0.5.53.15] - 2026-06-10

### Added (Phase 3 — Aosom video ingest, DRY-RUN)
- **`scripts/aosom-video-ingest-dry-run.mjs`** (read-only): validates the Shopify API path
  for attaching Aosom MP4s to products without ingesting anything.
  - **Scopes:** token has `write_products` ✅ but is **missing `write_files` / `read_files`**
    (the Phase-0 audit had assumed `write_products` sufficed).
  - **API test:** `stagedUploadsCreate(resource: VIDEO)` **succeeded for all 3** tested
    top-30 SKUs (17/30 have a `products.video` URL) — returned GCS staging targets +
    `external_video_id`, proving product videos route through the **product-media** path
    (covered by `write_products`), not the Files API. **No upload, no product change.**
  - Report: `docs/aosom-video-ingest-dry-run.md`. Real ingestion (upload bytes +
    `productCreateMedia` + poll to READY) is **NOT** done — awaiting Mat's validation.

## [0.5.53.14] - 2026-06-10

### Added (Phase 2 — lifestyle featured image, DRY-RUN)
- **White-background detection for featured-image selection.** `variant-merger.ts` gains an
  async curation path: `classifyImageBackground` downloads an image (≤5s, ≤2MB) and measures
  the near-white pixel ratio in its outer-10% border via `sharp` (lazy-imported); >80% reads
  as a white studio background, <80% as lifestyle. `selectProductImagesAsync` orders images
  lifestyle-first (URL regex OR border analysis) → CSV order (unknown/failed) → white
  backgrounds last, keeping the sub-800px filter and 8-image cap. Every failure path
  (timeout, oversize, decode/network error) degrades to "keep CSV order" (failsafe).
- **Job 3 integration:** `import-pipeline.ts` (`queueForImport`) now curates images via the
  async path, so **new imports** get the lifestyle-first ordering. The daily sync is
  untouched (the sync URL-only `selectProductImages` stays for catalog-scale paths).
- **DRY-RUN report:** `scripts/lifestyle-image-dry-run.mts` (read-only) ran the heuristic on
  the 30 top-seller SKUs (docs/audit-pdp-video.md). **24/30 would switch their featured image
  from a white-studio shot to a lifestyle shot**; 6 already lifestyle. Report:
  `docs/lifestyle-image-dry-run.csv`. No Shopify/DB writes. Backfill of existing products
  awaits Mat's validation.
- Tests: `classifyImageBackground` + `selectProductImagesAsync` covered (sharp-generated
  fixtures, injected fetch, failsafe). Full suite 765 green, `tsc --noEmit` clean.

## [0.5.53.13] - 2026-06-10

### Changed (PREVIEW theme `160213696617` only — live untouched)
- **B2 — removed fabricated testimonials.** The "Évaluations de nos clients" multicolumn (5
  invented reviews, 2 "Anonyme") was removed from `index.json` rather than replaced with new
  fake named testimonials (deceptive advertising). The real Judge.me widget stays.
- **B3 — carousels 3 → 2.** Removed `featured_collection1` ("Mobilier extérieur"), which
  overlapped "Coups de cœur" by ~93% (217/≈233 products). Kept "Meilleures offres" (rabais) +
  "Coups de cœur".
- **B3 — reduced "livraison gratuite" repetition** on the home from 8 mentions to 3 (kept the
  hero headline + reassurance bar + structural `why_us` icon; removed/reworded `lc_story2`,
  `lc_trust`, `lc_howit`, `shop_pay_home`, `rich_text`).
- **Preview SEO finalize.** Applied A3 (og:image) + A4 (meta description) to the preview too,
  so promoting it does not revert the live SEO. Removed the earlier duplicate og injection.

### Added
- **`docs/preview-qa-report.md`** — automated QA across the live storefront + preview assets:
  **16 ✅ / 0 ❌ / 0 ⚠️**. Scripts under `scripts/*qa*`, `apply-homepage-improvements.mjs`,
  `apply-preview-seo-finalize.mjs` (all preview-guarded).

## [0.5.53.12] - 2026-06-10

### Fixed (P0, PREVIEW theme `160213696617` — live untouched)
- **featured-collection Liquid render error.** The Phase-1 `where: 'available'` pre-filter
  produced a plain Array, which `{% paginate %}` rejects: *"Array 'cc_available_products' is
  not paginateable"* (`sections/featured-collection.liquid:108`). Restored pagination over
  `section.settings.collection.products` (the original working construct) and moved the
  availability check **inside** the loop (`{%- if product.available -%}`). Keeps the
  sold-out-skip intent without the broken array; fixes all featured-collection instances
  (one shared section file). Verified: 0 `cc_available_products` remain.

## [0.5.53.11] - 2026-06-10

### Changed (PREVIEW theme `160213696617` only — live untouched)
- **B4 — fixed the duplicate "500" social-proof numbers on the home.** Real counts:
  497 active products (not 500+, so the claim was slightly overstated). In
  `templates/index.json`: `lc_hero` and `lc_howit` product counts → "490" (497 rounded down
  to the nearest ten, conservative + accurate); `lc_trust` H2 "Plus de 500 familles
  canadiennes nous font confiance" (unverifiable, duplicate number) → "Satisfaction garantie
  30 jours" / "30-day satisfaction guarantee" (verifiable via the 30-day return policy). 6
  string replacements, verified by re-read (0 stale "500" social-proof strings remain).
  `scripts/apply-social-proof-preview.mjs` (hard-aborts if not the unpublished preview).

## [0.5.53.10] - 2026-06-10

### Changed
- **A2 — quantity steppers removed from product cards (PREVIEW `160213696617` only).**
  The +/- steppers appeared on cards only where a section used `quick_add: "bulk"`
  (single-variant → `card-product.liquid` renders `quantity-input`). The idempotent
  `scripts/preview-card-fixes.mjs` switches those to `quick_add: "standard"` (keeps a single
  add-to-cart button, drops the stepper) across `templates/index.json` (3 home carousels)
  and `templates/collection.json` (1). Quantity belongs on the PDP, not the card.

### Not applied
- **"Default Title" variant label on cards.** A full theme scan found **no visible
  `variant.title` render** on cards (only aria-labels, already de-verbosed by the Phase-1
  `fr.json` change). There is nothing to guard with `{% unless variant.title == 'Default
  Title' %}`. Awaiting an example card URL from Mat to locate the actual source.

## [0.5.53.9] - 2026-06-10

### Docs
- **B1 — discount credibility audit (dry-run, no writes).** `scripts/discount-audit.mjs`
  scans all 502 Shopify products (read-only GraphQL) for variants with
  `compareAtPrice > price`, computes the headline discount %, and buckets it against the
  ≥10% strikethrough rule. Result: 28 on-sale products — **0 below 10%** (nothing to remove),
  24 in 10–40% (ok), 4 above 40% (review). Report in `docs/discount-audit.csv`
  (product_id, title, price, compare_at_price, discount_pct, bucket). No product writes; no
  remediation applied (awaiting decision).

## [0.5.53.8] - 2026-06-10

### Changed (LIVE theme `160059195497` — authorized)
- **A3 og:image on the home — LIVE.** Patched `snippets/meta-tags.liquid` with an
  `{% if request.page_type == 'index' %}` branch so the homepage og:image is the 1200×630
  Unsplash patio asset (`assets/og-image-social.jpg`, uploaded to the live theme) instead of
  the 488px logo. Single og:image tag (the earlier `layout/theme.liquid` injection that
  duplicated the tag was reverted from backup). Other page types keep `page_image`.
- **A4 home meta description — LIVE.** Not settable via the public Admin API (the
  `global.description_tag` metafield is ignored by the theme; the home is not a Page). Applied
  via the same index-branch theme approach in `layout/theme.liquid` (`<meta name="description">`)
  and `meta-tags.liquid` (`og_description` → og/twitter): the home now uses the FR V1 text;
  other pages unchanged.

### Removed
- **Orphan shop metafields** `global.description_tag` and `global.og_image` deleted — they were
  created earlier but never read by the theme (verified no render effect).

### Ops
- `docs/DATA-OPS-LOG.md` logs the live writes (with backups). Scripts:
  `apply-seo-metafields.mjs`, `apply-og-live-v2.mjs`, `apply-meta-desc-live.mjs`,
  `verify-og-live.mjs`.

## [0.5.53.7] - 2026-06-10

### Changed
- **Phase 1 anti-cheap PDP/home fixes — PREVIEW theme `160213696617` only** (never live
  `160059195497`). Applied via the idempotent `scripts/preview-pdp-cheap-fixes.mjs` (Asset
  API, anti-clobber guards, JSON validation):
  1. **Duplicate PDP title** removed — `sections/main-product.liquid` rendered the title
     twice (`<h1>` + a redundant `<h2 class="h1">` link); now a single clean `<h1>`.
  2. **Verbose quantity labels** shortened at the root — `locales/fr.json`
     `quantity.decrease/increase` were "Réduire/Augmenter la quantité **de {{ product }}**";
     now sober "Réduire/Augmenter la quantité" (fixes PDP, cart, featured at once).
  3. **Emoji reassurance badges → thin-line navy (#1B2A4A) SVG.** The home `why_us`
     multicolumn (🚚🏆🔄📞 titles) became a custom-liquid row of inline SVG icons
     (livraison / qualité / retours / support); announcement-bar emojis (🚚🔄🔒⭐) stripped
     for clean text (SVG impractical in a text strip).
  4. **Sold-out products excluded from carousels** — `sections/featured-collection.liquid`
     now pre-filters `collection.products | where: 'available', true`, so home carousels
     (Meilleures offres, Coups de cœur) and any featured-collection skip out-of-stock items.
- **Not applied: literal "##" in descriptions.** A full scan found **0/502** product
  descriptions contain "##"; the description block renders raw HTML with nothing to strip.
  Flagged for Mat (needs a specific example URL — likely a custom_liquid block or metafield).

## [0.5.53.6] - 2026-06-10

### Changed (preview theme `160213696617` only — live untouched)
- **A3 og:image:** uploaded an Unsplash 1200×630 patio-lifestyle image as
  `assets/og-image-social.jpg` and injected `<meta property="og:image">` (via `asset_url`)
  before `</head>` in the preview `layout/theme.liquid`. Caveat documented: it coexists with
  Shopify's `content_for_header` og:image (2 tags) — the clean fix remains the admin Social
  sharing image setting. `scripts/og-unsplash-search.mjs` + `apply-og-newsletter-preview.mjs`.
- **A5 newsletter dedup:** removed the home-body `lc_newsletter` ("Restez à l'affût") section
  from the preview `templates/index.json` (section + `order`); kept the site-wide footer
  `newsletter_DPwWK7`. Klaviyo (account XAvTkS) unaffected — both were native Shopify forms
  feeding the Shopify→Klaviyo sync.

### Docs
- **A4 meta description:** `docs/HOME-META-DESCRIPTION.md` now states the final chosen V1 text
  and the exact admin path (Online Store → Preferences → Homepage meta description) — not
  API-writable. `docs/DATA-OPS-LOG.md` logs the three preview-theme writes. The apply script
  hard-aborts if the target is the live theme or not unpublished.

## [0.5.53.5] - 2026-06-10

### Added
- **A1 supplier-brand title cleanup — applied.** New `scripts/brand-cleanup-dry-run.mjs`
  scans all products via Admin GraphQL for Aosom house-brand tokens leaking into `title`
  (Outsunny, HOMCOM, Aosom, Vinsetto, Kleankin, Zonekiz +
  Soozier/Qaba/PawHut/Sportnow/Aiyaplay/Rosefray; third-party makers like Teamson
  excluded). Cleans the title (brand removed, double space/comma and orphan separators
  tidied, word-joining hyphens like "Brise-Vue" preserved, handles untouched). Vendor left
  unchanged ("Aosom"), per Mat. **7 of 502 titles affected and updated** via `--apply`
  (`productUpdate`, title only); post-write re-scan confirms 0 remaining. Dry-run report:
  `docs/brand-cleanup-dry-run.csv` (UTF-8 BOM).

## [0.5.53.4] - 2026-06-10

### Docs
- **A4 — Homepage meta description rewrite proposed.** Current description is ~230 chars in
  shouty CAPS with "free shipping" twice. `docs/HOME-META-DESCRIPTION.md` proposes two
  ~145-char natural-language FR variants (seasonal/local vs evergreen catalogue) with a
  recommendation. The home renders `{{ page_description }}` from the shop-level
  **Online Store → Preferences → Homepage meta description** SEO setting — not a theme file
  and not writable via the public Admin API — so the doc gives the exact admin path. No
  live-theme edit.

## [0.5.53.3] - 2026-06-10

### Docs
- **A3 — Social sharing image (og:image) documented.** The home og:image is currently the
  488px logo, not a 1200×630 lifestyle image. Diagnosed (`scripts/audit-home-meta.mjs`) that
  og:image is the shop-level **Online Store → Preferences → Social sharing image** setting —
  not a theme file and not writable via the public Admin API (Shopify injects it via
  `content_for_header`, falling back to the logo). `docs/SOCIAL-SHARING-IMAGE.md` gives the
  exact admin steps + a 1200×630 lifestyle-image recommendation. No live-theme edit.

## [0.5.53.2] - 2026-06-10

### Docs
- **PDP + video Phase 0 audit (read-only).** `docs/audit-pdp-video.md` answers the 6
  Phase-0 questions with exact `file:line` citations and live Shopify/Turso evidence:
  featured-image selection (`selectProductImages`, lifestyle-URL promotion else CSV order),
  the Aosom CSV `Video` MP4 field (2210/11126 products populated), the Shopify video media
  path + granted scopes (`write_products` yes, `read_orders` no), the PDP title/`##` finding
  (published pages clean; symptom traced to draft-URL→home redirect + leading marketing
  `<h2>`), the home carousels (featured-collection on `rabais`/`coups-de-coeur`/
  `mobiliers-exterieurs-et-jardins`, best-selling sort, no sold-out filter under dropship),
  and a top-30 best-seller shortlist by inferred stock velocity. Read-only diagnostic
  scripts under `scripts/audit-*.mjs`. No writes performed.

## [0.5.53.1] - 2026-06-09

### Docs
- **Google Customer Reviews setup documented (no theme change).** The requested injection of
  the GMC survey opt-in (merchant `5804673777`) into the order-confirmation page is not
  possible on this store: theme `160059195497` is Online Store 2.0 (no `checkout.liquid` /
  order-status section), the plan is Basic, and the confirmation page is checkout-owned. The
  legacy injection points (order-status Additional Scripts and `order_status` ScriptTags) were
  disabled by Shopify on 2025-08-28. Added `docs/GOOGLE-CUSTOMER-REVIEWS-SETUP.md` (runbook for
  the supported Google & YouTube channel app + Merchant Center path) and a `docs/DATA-OPS-LOG.md`
  entry. No theme/app code changed; no Shopify writes performed.

## [0.5.53.0] - 2026-06-09

Live Shop Pay widget cleanup on the product page + the 2026-06-09 security audit.

### Changed
- **Shop Pay finance block (live theme `160059195497`, `templates/product.json`).**
  The `shop_pay_finance` block computed its own "Payez en 4 × $XX avec Shop Pay" line
  (`price ÷ 4`), which can diverge from the real Shop Pay Installments terms. Replaced it
  with a branded navy/gold banner carrying no hardcoded figure, plus a CSS rule enlarging the
  **native** `<shopify-payment-terms>` widget (`font-size:18px; font-weight:600`) so Shopify
  renders the actual installment amounts. Neutral wording ("plusieurs versements", not "sans
  intérêts") to avoid an inaccurate interest-free claim on the storefront. Applied via the new
  idempotent `scripts/fix-shop-pay-widget.mjs` (anti-clobber guard, PUT confirmed 200).
- **`scripts/_shopify-lib.mjs`**: corrected a stale comment — theme `160059195497` is now
  `role:main` (published/live), no longer the unpublished preview copy.

### Security
- **`/cso` daily audit (8/10 gate) — no P0/P1.** `docs/SECURITY-BACKLOG.md` gains the
  2026-06-09 section covering #125/#126/#127 and the theme edit. Verified clean: all 9 cron
  routes self-gate (`verifyCronSecret` + `timingSafeEqual`), the new paid `/api/videos/generate`
  route is session-gated, price-alert uses a server-side baseline price. New **P3-7** (extract
  the copy-pasted `verifyCronSecret` into a shared `lib/cron-auth.ts` helper); **P3-5/P3-6**
  (video-serve path containment + redirect host allowlist) re-confirmed still open.

## [0.5.52.0] - 2026-06-09

Recâblage du pipeline vidéo sur `video_jobs` comme source de vérité unique
(suite à la note PR #118). Le moteur Kling était branché à l'UI mais orphelin —
il ne faisait que mettre un job en file sans jamais rendre la vidéo — et un
`setDraftVideoPath` mort écrivait encore dans `facebook_drafts.video_path`.

### Changed
- **Kling rendu via `/api/videos/generate` → `video_jobs`** (`route.ts`,
  `video-generate.ts`): la route accepte désormais `engine: 'ffmpeg' | 'kling'`.
  Nouveau `runKlingGeneration` qui lance `generateKlingVideo` en arrière-plan et
  écrit `video_path`/`video_url` dans `video_jobs` via `updateVideoJob`. Échec
  rapide (400) quand Kling n'est pas configuré (`KLING_API_KEY` absent). Ajout de
  `selectProductImages` + `toKlingProduct`.
- **Durabilité Blob partagée**: extraction de `resolveDurableVideoUrl` (upload
  Vercel Blob + repli sur la route de streaming), désormais utilisée par les deux
  moteurs — les clips Kling sont donc servis correctement entre instances Vercel,
  comme la slideshow FFmpeg.
- **Dashboard**: Kling poste maintenant vers `/api/videos/generate` (rend la
  vidéo) au lieu de la file `/api/videos` (qui ne faisait que mettre en attente).

### Removed
- **`setDraftVideoPath` + `FacebookDraft.videoPath`** (code mort): plus rien
  n'écrivait dans `facebook_drafts.video_path`. La colonne reste (legacy) pour
  les lignes existantes; `video_jobs.video_path` est la source canonique.

## [0.5.51.0] - 2026-06-09

### Added
- **Cron instrumentation for the dashboard "Résumé du jour".** Wrapped the three
  remaining un-instrumented cron routes — `/api/cron/blog`, `/api/cron/content`,
  `/api/cron/csv-precache` — in `trackCron()`, so each run records success/error
  (+ message) in `cron_runs`. blog/content throw on total bilingual failure so it
  logs as `error` while keeping their existing 500 response shape. The feeds
  (`google`/`meta`/`meta_xml`/`pinterest`/`pinterest_en`) were already instrumented
  via `recordFeedSync`.

### Fixed
- **`trackCron` recording is now genuinely best-effort.** A `recordCronRun` failure
  (telemetry DB write) no longer turns a successful cron into a 500, nor masks the
  original error on the failure path — it is caught and logged. Matches the helper's
  documented contract. New `tests/cron-tracking.test.ts`.

## [0.5.50.0] - 2026-06-09

Catch-up version bump: four PRs merged to `main` without bumping VERSION/CHANGELOG
(VERSION stayed at 0.5.47.0–0.5.48.0 through these merges). This entry documents
them; no code change. Note: 0.5.49.0 was PR #121 (meta Dynamic Ads).

### Added
- **Klaviyo email flows + Umami verification** (#119): `scripts/setup-klaviyo-flows.mjs`
  creates the `Newsletter` list, bootstraps the `Price Drop Alert` custom metric, and
  builds the four core flows (Welcome Series, Abandoned Cart, Post-Purchase review
  request, Price Drop Alert) in **draft** via the Klaviyo API (revision `2025-01-15`
  for flow creation). Bilingual FR/EN templates; IDs recorded in
  `docs/KLAVIYO-FLOWS.md`. Confirmed Umami tracking is live on the storefront and
  documented API + no-key verification in `docs/UMAMI-SETUP.md`.
- **FFmpeg engine wired into the video dashboard** (#120): the "Générer" tab renders a
  real MP4 through `/api/videos/generate` (async job + status polling), surfacing the
  FFmpeg slideshow engine in the UI.
- **Catalogue improvements** (#123): advanced filters, bulk import, and a stats header
  on the catalogue page.

### Changed
- **Video renders → Vercel Blob + dashboard polish** (#122): `runFfmpegGeneration`
  uploads the rendered MP4 to Vercel Blob and stores the permanent `video_url`, so
  `GET /api/video-serve/:id` works across ephemeral Vercel instances (falls back to
  on-disk serving when no Blob token is set, and a transient Blob failure keeps the
  job `ready`). Dashboard: post-submit redirect to the queue tab + clearer empty
  states. `BLOB_READ_WRITE_TOKEN` documented in `.env.example` and
  `docs/VIDEO-PIPELINE-FFMPEG.md`.

## [0.5.49.0] - 2026-06-09

### Added
- **Meta Dynamic Ads foundation.** `createAdSet(adAccountId, params)` +
  `CreateAdSetParams` in `src/lib/meta-ads-client.ts` — creates a (PAUSED) ad set with
  nested `targeting` + `promoted_object`, defaulting to `IMPRESSIONS` /
  `LOWEST_COST_WITHOUT_CAP` / `OFFSITE_CONVERSIONS`. Complements the existing
  `createCampaign`.
- **`scripts/create-meta-dynamic-ads.mjs`** — builds the first catalog-retargeting
  campaign + ad set for `act_20658834` (catalog `1103064966519153`). **Dry-run by
  default** (prints payloads, sends nothing); `--apply` gated behind a token preflight
  and a required `--audience-id`. Both objects are created PAUSED.
- **`docs/META-ADS-SETUP.md`**: Dynamic Ads section (payloads, ODAX/`OUTCOME_SALES` and
  `product_set_id` caveats, audience requirement) + `createAdSet` in the API table.
- Tests: 3 new in `tests/meta-ads-client.test.ts` (catalog-sales objective, ad-set
  defaults, overrides).

## [0.5.48.0] - 2026-06-08

Merge of `feature/video-engines-publishing` into `main`. The `/api/video-serve/[id]`
route was resolved to main's `video_jobs`-based implementation (#115, below); the
entries here cover this branch's engine + publishing work.

### Added
- **Kling AI video engine** (`src/lib/video-engines/kling-client.ts`): turns a product's
  best photo into a cinematic 9:16 clip — picks the best image, generates a cinematic
  prompt via Claude (templated fallback), calls Kling `/v1/videos/image2video`, polls to
  completion (5min budget), downloads the clip, and runs a best-effort FFmpeg brand
  overlay (navy band + logo, `ffmpeg-brand.ts`). No-ops when `KLING_API_KEY` is unset.
- **Reels publishing**: `publishFacebookReel` in `facebook-client.ts` (resumable
  `/video_reels` start→upload→finish) and `publishReel({videoUrl,caption,pageId,locale})`
  in `social-publisher.ts` routing the Page token per locale. Instagram Reels already
  shipped via `instagram-client.publishReel`.
- **`facebook_drafts.video_path` column + `setDraftVideoPath`**: records a rendered
  clip's local path on a draft (written by the Kling/FFmpeg engines).

### Changed
- **Creatomate client → engine**: moved `creatomate-client.ts` to
  `video-engines/creatomate-engine.ts` with separate FR/EN templates
  (`CREATOMATE_TEMPLATE_ID_FR`/`_EN`, falling back to `CREATOMATE_TEMPLATE_ID`) and shared
  `VIDEO_BRAND` token injection (`renderProductVideoForLocale`).
- **Job 4 → static posts only**: decoupled inline Creatomate video rendering out of
  `job4-social.ts`; video generation is now owned by the FFmpeg slideshow / engine
  pipeline. Adds the `ffmpeg-static` dependency.

## [0.5.47.0] - 2026-06-08

Catch-up version bump: three video feature PRs (#113, #114, #115) merged to `main`
without bumping VERSION/CHANGELOG. This entry documents them; no code change.

### Added
- **Video dashboard skeleton** (#113): `video_jobs` table + indexes, `VideoJob`
  types and `create`/`get`/`list`/`update`/`delete` helpers in `database.ts`;
  `GET`/`POST /api/videos` and `PATCH`/`DELETE /api/videos/[id]` (all
  `isAuthenticated`-gated, writes blocked for `reviewer`); the `/videos` page with
  4 tabs (Générer / File d'attente / Bibliothèque / Publier) + "Vidéos" nav entry.
- **Video pipeline foundation** (#114): brand tokens, Job4 decoupling, and the
  FFmpeg slideshow engine (`src/lib/video-engines/ffmpeg-slideshow.ts`).
- **Public video delivery route** (#115): `GET /api/video-serve/[id]` — 302-redirects
  to `video_url` when set, otherwise streams the local MP4 (`video/mp4`,
  `Accept-Ranges: bytes`, Range/206 support), else 404. Allow-listed in `proxy.ts`
  so the FB/IG Graph APIs can fetch a Reel video by id with no session.
- **furnishdirect.ca EN domain binding** (#115): `docs/FURNISHDIRECT-DOMAIN-SETUP.md`
  updated with the scriptable steps now that `read_markets`/`write_markets` are
  granted, plus `scripts/bind-furnishdirect-domain.mjs` (dry-run by default) which
  adds a second web presence on the Canada market bound to `furnishdirect.ca` /
  `defaultLocale: en`.

## [0.5.46.0] - 2026-06-07

### Added
- **Dashboard "Résumé du jour" panel** (`src/app/(dashboard)/day-summary-panel.tsx`):
  new products imported today (`price_history` `new_product` events), social drafts
  generated in the last 7 days, active (confirmed) price alerts, estimated Meta-Ads
  revenue over 30 days (ROAS × spend, merged from the cached `/api/ads/insights`), and
  each cron's last run with success/error status.
- **Dashboard "Alertes" panel** (`src/app/(dashboard)/alerts-panel.tsx`): import jobs in
  `status='error'` (with SKU pulled from `product_data`), social drafts pending > 7 days,
  Meta token expiry (via Graph `debug_token` — warns when expired or within 7 days), and
  the last successful fetch per Google/Meta/Pinterest feed. Shows an all-clear state when
  nothing needs attention.
- **Cron + feed run tracking** to back those panels: new `cron_runs` and `feed_syncs`
  tables + `recordCronRun`/`recordFeedSync`/`getDashboardSummary`/`getDashboardAlerts` in
  `database.ts`. The sync-family + social crons record via a `trackCron` wrapper
  (`src/lib/cron-tracking.ts`); the Google/Meta/Pinterest feed routes record each fetch.
  (blog/content/csv-precache crons will be wrapped in a follow-up — the table is ready.)
- **`getTokenInfo()`** in `meta-ads-client.ts` (Graph `debug_token`) and pure, unit-tested
  helpers in `src/lib/dashboard-metrics.ts` (date windows, revenue, token-expiry
  classification). Two new API routes: `GET /api/dashboard/summary` and
  `GET /api/dashboard/alerts` (both `isAuthenticated`-gated). 19 new tests.

## [0.5.45.0] - 2026-06-07

### Added
- **Instagram Reels (9:16 video) support.** Previously the publisher skipped video
  on Instagram and posted only the image; now it posts a Reel when a video is
  available.
  - `createReelsVideo()` / `renderReelsVideoAndWait()` in `creatomate-client.ts`
    render a vertical 1080x1920 video from a dedicated `CREATOMATE_REELS_TEMPLATE_ID`.
  - `publishReel()` in `instagram-client.ts` — IG Graph Reels flow: create a
    `media_type=REELS` container, poll `status_code` until the upload finishes
    processing, then `media_publish`.
  - `job4-social` renders the 9:16 reel alongside the square Facebook video
    (best-effort, independent — a reel failure never blocks the draft); stored on
    the new `facebook_drafts.reels_video_url` column.
  - The publisher posts the Reel on Instagram (preferring the 9:16 `reelsVideoUrl`,
    falling back to the square `videoUrl`), and still posts the square video on
    Facebook.

## [0.5.44.0] - 2026-06-07

### Fixed
- **Catalog "In store" links now open the storefront, not the Shopify admin**
  (`src/lib/database.ts`). The catalog `StoreBadge` (added in #107) calls
  `storeLink(shopify_product_id, shopify_handle)`, which prefers the public
  `/products/{handle}` URL — but `getProducts` never SELECTed `shopify_handle`, so the
  badge only saw the numeric id and fell back to the admin product page. Added
  `shopify_handle` to the catalog projection (`catalogColumns` + the CTE `selectCols`);
  `ProductRow`, `rowToProduct`, and `storeLink` already supported it. 2 direct-SQL tests
  lock in that the projection carries `shopify_handle` and that `storeLink` then yields a
  storefront URL (admin fallback only when the handle is missing).

## [0.5.43.0] - 2026-06-07

### Added
- **Creatomate foundation for automated product videos.** New
  `src/lib/creatomate-client.ts` (`createVideoFromTemplate` → render job id,
  `getVideoStatus` → `{status, url}`, `renderVideoAndWait` bounded poll; no-ops
  without `CREATOMATE_API_KEY`). On a **new_product** draft, when
  `CREATOMATE_API_KEY` + `CREATOMATE_TEMPLATE_ID` are set, job4 renders a 1080×1080
  branded video (product image + title + price + logo) and stores the MP4 in the
  new `facebook_drafts.video_url` column. The publisher **prefers the video on
  Facebook** (`publishVideo` → `/{page}/videos`), falling back to the image.
  Instagram keeps the branded image (Reels = follow-up). Setup +
  template/variable guide in `docs/CREATOMATE-SETUP.md`. Foundation: renders are
  async (bounded ~90s wait; slow renders attach later via a future webhook/cron).

### Added
- **Configurable Meta ad account for the dashboard ads panel.** New optional
  `META_AD_ACCOUNT_ID` env var: when set, `/api/ads/insights` reports on that
  account instead of auto-picking the first ACTIVE one. New pure, unit-tested
  `pickAdAccount()` helper (prefers the configured id with/without the `act_`
  prefix, falls back to first ACTIVE, then first).

### Fixed
- **"In store" / "Not imported" badge now works on mobile and desktop.** The
  catalog badge was keyed to `import_status`, a field the catalog API never
  returns, so it rendered on neither layout. It now derives from
  `shopify_product_id` via the shared `storeLink` helper and shows in both the
  mobile cards and the desktop table — "In store" links to the Shopify product
  (storefront when the handle is known, else admin), clickable on mobile too;
  "Not imported" is a muted badge.

## [0.5.41.0] - 2026-06-07

### Changed
- **Deployed the double-opt-in price-alert widget to the live theme** (160059195497).
  The live `price_drop_alert` block still held the old single-opt-in copy ("You're on the
  list…"); replaced it with the canonical `docs/snippets/price-drop-alert.liquid` (animated
  success panel, validation, error handling) whose post-submission message reads "Check
  your email to confirm your alert." / "Vérifiez votre courriel pour confirmer votre
  alerte." New `scripts/update-price-alert-block.mjs` rewrites only that block's
  `custom_liquid` (dry-run by default, `--apply` to PUT); logged in `docs/DATA-OPS-LOG.md`.

### Added
- **`scripts/markets-status.mjs`** — read-only Shopify Markets/locales/scopes probe.
- **`scripts/inspect-product-template.mjs`** — read-only inspector for the live theme's
  `templates/product.json` blocks.

### Docs
- **`docs/FURNISHDIRECT-DOMAIN-SETUP.md`** rewritten with the current state (verified
  2026-06-07): `read_markets`+`write_markets` are now granted (the prior 403 is resolved),
  the store has one region-scoped "Canada" market, and both locales are published. Explains
  why a *second* EN market isn't the right model for English-Canada (a country belongs to
  one market — the FR/EN split is a language+domain mapping inside the Canada market) and
  gives the connect-domain → bind-EN-domain steps + GraphQL path for once furnishdirect.ca's
  DNS is configured. No market was created (domain not connected yet).

## [0.5.40.0] - 2026-06-07

### Added
- **Pinterest EN feed setup guide** (`docs/PINTEREST-EN-SETUP.md`). Step-by-step
  for adding the second (English) catalog source in Pinterest — URL
  `/api/feeds/pinterest-en`, Language English (US), Country Canada — same
  procedure as the already-configured FR feed.

### Changed
- **Price-drop "notify me" widget UX overhaul** (`docs/snippets/price-drop-alert.liquid`,
  injected into live theme 160059195497). No-reload animated ✓ success panel that
  replaces the form on submit; client-side email validation before the network
  call; a button loading state (spinner + "Sending…/En cours…"); and friendly
  error handling that maps the real API responses (429 rate limit, 404 unknown
  product, network failure). Success copy stays double-opt-in accurate ("check
  your email to confirm"). Respects `prefers-reduced-motion`.

## [0.5.39.0] - 2026-06-07

### Changed
- **Blog topic catalogue expanded 12 → 30 bilingual topics** (`src/lib/blog-topics.ts`).
  18 new FR/EN topic pairs with shared English Unsplash queries, covering 2026 decor
  trends, small-space/studio living, all-season (Quebec winter) outdoor furniture,
  furniture care, decor styles (industrial, bohemian, modern minimalist), kid-safe
  furniture, storage & organization, pet-friendly furniture, budget decor, and
  DIY/upcycling. The weekly cron rotation (`week % length`) now cycles through 30
  subjects before repeating. New tests assert ≥30 topics and no duplicate FR/EN/query.

## [0.5.38.0] - 2026-06-07

### Added
- **Meta Ads panel on the dashboard** (`src/app/(dashboard)/meta-ads-panel.tsx`,
  wired into `dashboard-client.tsx`). Shows last-30-days headline metrics: spend
  (CAD), reach, clicks, ROAS, CPM, CTR. When `META_ACCESS_TOKEN` is absent it
  renders a "Connectez votre compte Meta Ads" CTA linking to the setup guide
  (`docs/META-ADS-SETUP.md`) instead of erroring.
- **`GET /api/ads/insights?days=30`** (`src/app/api/ads/insights/route.ts`):
  session-protected (`isAuthenticated`), resolves the first ACTIVE ad account,
  pulls account-level insights via `meta-ads-client.getInsights`, aggregates the
  six metrics. Cached in-process for 1h keyed by (account, days); responses are
  `Cache-Control: no-store` (auth-gated data). Returns `{configured:false, reason}`
  (200) when the token/account is missing so the panel can show its CTA.
- **`src/lib/ads-insights.ts`** — pure, unit-tested helpers: `aggregateInsights`
  (canonical `purchase_roas` — never sums overlapping action types; max-based reach;
  divide-by-zero-safe CPM/CTR), `rangeForDays` (UTC, clamped 1–365), `parseDays`.
  12 tests in `tests/ads-insights.test.ts`.

## [0.5.37.0] - 2026-06-07

### Added
- **Double opt-in for price alerts.** Price-drop signups now require email
  confirmation before any alert is sent:
  - `price_alerts` gains `confirmed` / `confirm_token` / `token_expires_at`
    (CREATE for new DBs + ALTER migration for the table shipped in #99).
  - `POST /api/price-alert` issues a single-use UUID token (24h TTL), stores the
    row as `confirmed=0`, and emails a confirmation link via Klaviyo
    (`Price Alert Confirmation` event).
  - `GET /api/price-alert/confirm?token=…` marks the alert confirmed, clears the
    token, and redirects to the product page (`?price_alert=confirmed`); invalid
    or expired tokens get a bilingual error page.
  - The notify cron now only emails `confirmed=1` alerts — so price drops never
    reach an address that didn't opt in. Storefront widget copy updated to
    "check your email to confirm".

## [0.5.36.0] - 2026-06-07

### Added
- **Second Pinterest feed in English** (`GET /api/feeds/pinterest-en`). Same RSS
  shape as `/api/feeds/pinterest`, but product titles come from the
  `custom.title_en` metafield (falling back to the FR title when it's absent or
  blank), to widen reach with the anglophone Canadian audience. Titles are
  resolved via a paginated Shopify GraphQL query (REST `products.json` does not
  return metafields). CDN-cached 24h; public via the existing `/api/feeds`
  allowlist prefix.
- **Meta Ads automation foundation.**
  - `src/lib/meta-ads-client.ts` — Meta Marketing API v18.0 client (native fetch):
    `getAdAccounts`, `getCampaigns` (active only), `createCampaign` (defaults to
    `PAUSED` so it never auto-spends), `getAdSets`, `getInsights` (spend / reach /
    impressions / clicks / CPC / CPM / CTR / ROAS). Process-local guardrail caps
    usage at 200 calls/hour.
  - `GET /api/ads` — session-protected (`isAuthenticated`); `?resource=accounts`
    (default) | `campaigns` | `insights` (current calendar month). Returns `503`
    when `META_ACCESS_TOKEN` is unset.
  - `docs/META-ADS-SETUP.md` — how to connect an ad account + token to the app.

## [0.5.35.0] - 2026-06-07

### Fixed
- **Catalog price-movement badge now renders** (`src/lib/database.ts`,
  `src/app/(dashboard)/catalog/page.tsx`): the catalog table has long contained a
  ▼/▲ badge that compares each product's current price against `prev_price`, but
  `getProducts` never selected a `prev_price` column, so the badge was permanently
  dead code. Added a `last_price` CTE — `old_price` of each SKU's most recent
  `price_drop`/`price_increase`, selected with `ROW_NUMBER() OVER (PARTITION BY sku
  ORDER BY detected_at DESC, id DESC)` so the pick is deterministic even when two
  price changes share the same `detected_at` second (stock-only changes excluded) —
  LEFT JOINed into all three sort branches of `getProducts`. The badge now shows the
  real last price move and complements the existing "Plus gros rabais" (price drop %)
  sort. `ProductRow` gains an optional `prev_price` field; 3 direct-SQL tests cover
  latest-change selection, stock-change exclusion, and the detected_at tiebreak.

## [0.5.34.0] - 2026-06-07

### Added
- **Price-drop alerts ("notify me when the price drops").** Storefront visitors can
  subscribe to be emailed when a product's price drops:
  - `price_alerts` table (unique per email+sku) + helpers.
  - `POST /api/price-alert` — public, CORS-guarded (storefront origins only),
    per-IP rate-limited; validates the email + an existing SKU, stores the
    **server-side** current price as the baseline, and identifies the Klaviyo
    profile. (The baseline is taken from the catalog, not the client, so a
    forged price can't trigger a spurious alert.)
  - `GET /api/price-alert/notify` — daily cron (09:00 UTC, CRON_SECRET-gated):
    finds alerts whose price dropped below the signup baseline, fires a
    `Price Drop Alert` Klaviyo event per subscriber, and marks them notified
    (only on a confirmed send, so un-sent alerts retry).
  - Bilingual storefront widget as a ready Liquid snippet
    (`docs/snippets/price-drop-alert.liquid`) for the product page.

### Added
- **Klaviyo API client** (`src/lib/klaviyo-client.ts`, revision 2023-10-15):
  `trackEvent(metric, email, props)` and `identifyProfile(email, props)`, capped
  at 10 req/s, reading `KLAVIYO_API_KEY` from the env (no-ops when unset). A ready
  server-side capability — intentionally **not** wired into the catalog/sync jobs,
  because Klaviyo events need a recipient email and those jobs have no customer in
  scope. The browse/cart/price-drop flows are driven by Klaviyo onsite tracking +
  Shopify catalog sync (which Job 1 already feeds). `docs/KLAVIYO-SETUP.md`
  documents the client, the `KLAVIYO_API_KEY` setup, and the one valid future use
  (a price-drop "notify me" list with real subscriber emails).

## [0.5.32.0] - 2026-06-07

### Fixed
- **EN posts now carry the Furnish Direct (EN) logo** on their branded hero image. The
  compositor already supported per-locale logos, but the publisher posted one FR-branded
  image to both channels. `publishDraftToChannel` now rewrites the `/api/image-preview`
  URL's `locale` per channel, so EN channels (Furnish Direct) fetch the EN-branded variant
  while FR channels (Ameublo Direct) keep the FR logo — from a single draft.

## [0.5.31.0] - 2026-06-07

### Security
- **Removed the exact version from the public `/api/health` payload (P3-4 from `/cso`).**
  The endpoint no longer returns `version`, so an unauthenticated caller can't
  fingerprint the precise build against dependency CVEs. `status`/`db`/`lastSync`
  are unchanged for monitoring.

### Added
- **`docs/KLAVIYO-SETUP.md`** — setup guide for Klaviyo email automation
  (account + Shopify connection + Welcome / Abandoned-cart / Post-purchase /
  Browse-abandonment flows, bilingual FR/EN, post-purchase review ask via
  Judge.me). Documentation only — no Klaviyo code in the repo.

## [0.5.30.0] - 2026-06-07

### Security
- **Validated the `/api/image-preview` fallback redirect host (F2 from `/cso`).**
  On composition failure the public route 302-redirected to `products.image1`
  without checking the destination. It now requires HTTPS and an allow-listed
  image host (`cdn.shopify.com`, `img-us.aosomcdn.com`, `images.unsplash.com`)
  before redirecting, returning `502` otherwise — closing the open-redirect risk
  if a bad URL ever lands in the products table. Covered by a new route test.

## [0.5.29.0] - 2026-06-07

### Security
- **Constant-time cron-secret check on the content-generation endpoint.**
  `POST /api/social/content/generate` (a public-prefixed route that triggers paid
  Claude calls) compared its cron Bearer secret with `===`, a timing oracle, while
  every other cron route uses `crypto.timingSafeEqual`. Switched it to the same
  constant-time helper, fail-closed when `CRON_SECRET` is unset. Surfaced by a
  `/cso` security audit; two lower-severity items (image-preview redirect
  validation, `/api/health` version disclosure) are tracked in
  `docs/SECURITY-BACKLOG.md`.

## [0.5.28.0] - 2026-06-07

### Added
- **Meta Catalog XML feed** at `GET /api/feeds/meta-xml`. Meta Commerce ingests RSS/ATOM
  XML (not JSON), so this serves the same RSS 2.0 + `g:` shape as the Google feed, plus
  `g:custom_label_0` (= product_type) and `g:sale_price` (current price) alongside `g:price`
  (regular/compare-at) when a variant is discounted. Public via the existing `/api/feeds`
  proxy allowlist; cached 24h. The feed source now reads Shopify `compare_at_price`.

## [0.5.27.0] - 2026-06-07

### Changed
- **Imports now publish live immediately.** `createShopifyProduct` creates products with
  status `active` instead of `draft`, so an imported product goes straight to the storefront
  (and into the shopping feeds) with no manual draft-review step.

## [0.5.26.0] - 2026-06-06

### Added
- **Branded social post images.** New-product and stock-highlight posts now lead with
  a composed 1080x1080 image — the product photo on an off-white canvas, a navy footer
  band carrying the Ameublo Direct logo and the price, and an optional copper NEW badge —
  instead of the raw Aosom photo. Served by a new public `GET /api/image-preview` route
  (the URL Facebook/Instagram fetch when publishing), with the price baked into the URL
  so the cached image always matches the listing. Raw product photos still follow as the
  gallery. Set `NEXT_PUBLIC_APP_URL` (or rely on the Vercel production URL) to enable it;
  without a public base URL the pipeline falls back to the previous behavior.

### Fixed
- **Hardened image downloads against SSRF and resource abuse.** The shared image
  downloader now re-checks the internal-host guard on every redirect hop, times out
  requests, and caps download size; the compositor caps decoded pixels. The preview
  route is locked to known SKUs and redirects to the raw image rather than erroring, so
  a composition failure can never break a social post.

### Added
- **Shopping feeds** for Google Merchant, Pinterest, and Meta, generated from the live
  Shopify catalogue and served publicly (CDN-cached 24h):
  - `GET /api/feeds/google` and `/api/feeds/pinterest` — RSS 2.0 + `g:` namespace.
  - `GET /api/feeds/meta` — Meta Product Catalog JSON.
  - One item per priced variant SKU of an **active** product (item_group_id groups variants),
    linking to `ameublodirect.ca/products/{handle}`, with brand (vendor), price (CAD),
    availability, and a Google Product Category mapped from the product taxonomy
    (`src/lib/feeds/google-category.ts`).
  - All routes are public (added to `proxy.ts` allowlist). Hardened against feed-poisoning:
    XML-forbidden control chars stripped, `g:id` deduped, retry/backoff on Shopify 429/5xx,
    and a fail-loud guard rather than serving a truncated catalogue.

### Notes
- Feeds use the FR title from Shopify (matches the FR storefront they link to). Follow-ups:
  an EN feed for furnishdirect.ca (needs Shopify EN metafields) and refining availability
  from live Aosom stock.


### Changed
- **Deduplicated the Shopify catalog.** Re-imports had created products sharing variant SKUs.
  Removed all duplicate products (keeping one per cluster: active > most-recent > the listing
  the catalog links to) across two validated passes — **48 draft + 62 active = 110 deleted**,
  597 → **487 products, 0 duplicates remaining**. After each pass the SKU → `shopify_handle` /
  `shopify_product_id` backfill was re-run so the dashboard "In store" links point at the
  surviving products (969 catalog rows linked). 0 keepers ever deleted.

### Added
- `scripts/shopify-duplicate-products-diagnostic.mjs` — read-only duplicate detector (clusters
  products by shared SKU, proposes keepers, dry-run only). Full audit in `docs/DATA-OPS-LOG.md`.

## [0.5.23.0] - 2026-06-06

### Added
- **Auto-scheduling of approved editorial drafts.** Approving a `content_template` draft now
  schedules it onto the next free Mon/Wed/Fri 10:00 EST (15:00 UTC) slot — 1 FR + 1 EN per
  slot — and flips it to `scheduled`. Product drafts still go to `approved` for manual
  scheduling. Pure slot logic in `src/lib/draft-scheduler.ts` (13 tests).
- **`products.shopify_handle`** column + persistence. `createShopifyProduct` now returns the
  Shopify handle; imports persist it (and the product id) onto the catalog rows. The
  dashboard "In store" badge now deep-links to the storefront
  `ameublodirect.ca/products/{handle}`, falling back to the Shopify admin link when no
  handle is known yet.

### Notes
- A read-only backfill diagnostic (`scripts/shopify-handle-backfill-diagnostic.mjs`) showed
  only 74 of 11,093 catalog rows carry a `shopify_product_id` today, while SKU-matching
  reaches ~969 — so the mass backfill (and the "In store" coverage) is pending validation
  before any write.
- **furnishdirect.ca (EN domain):** configuration is blocked by missing Shopify scopes
  (`read_markets`/`write_markets` → 403) and an unavailable REST domains endpoint. Documented
  the manual DNS/admin steps + scopes in `docs/FURNISHDIRECT-DOMAIN-SETUP.md`. No live-store
  change was made.

## [0.5.22.0] - 2026-06-06

### Changed
- **Drafts review defaults to editorial content.** The drafts trigger filter now defaults
  to **Contenu** (`content_template`) and offers three options: Contenu | **Produits**
  (groups `new_product` + `stock_highlight`) | Tous. Product/stock drafts stay in the DB and
  are one click away. New parameterized `triggerTypeClause()` helper in `database.ts` powers
  the grouped "Produits" filter (covered by `tests/drafts-filter.test.ts`).

### Added
- **`scripts/drafts-purge-diagnostic.mjs`** — read-only diagnostic + dry-run for the draft
  backlog (distribution by `trigger_type`/status; per-rule purge counts). Performs no
  deletions; intended to validate purge rules before any cleanup.

### Notes
- The task spec referenced `content_type = 'content_template'`, but the post type lives in
  `trigger_type` (every row's `content_type` is `'product'`). Implemented against the correct
  column. The diagnostic also showed the proposed `hook_id IS NULL` purge rule would flag
  ~299 drafts as "incomplete" when only 1 is actually empty — surfaced for review rather than
  applied.


### Added
- **"In store" / "Not imported" indicator** on the dashboard Price Drops and Trending
  panels. Each product now shows a green **In store** badge (links to the Shopify admin
  product page) or an orange **Not imported** badge (links to the import dashboard), driven
  by `shopify_product_id`. New `src/lib/insights.ts` `storeLink()` helper maps the id to the
  badge state + deep link (built server-side); covered by `tests/insights.test.ts`.

### Security
- Ran `/cso` security review (daily, 8/10 gate): **no new P0/P1.** Verified the auth model
  (`src/proxy.ts` middleware gates all non-allowlisted routes), parameterized/whitelisted
  SQL, DOMPurify-wrapped HTML, and a session-or-cron-secret gate on the public LLM route.
  Prior backlog P2-1 (unauthenticated read routes) is now resolved by `proxy.ts`. Appended
  the audit + two P3 items (3 moderate npm advisories; image-fetch SSRF hardening) to
  `docs/SECURITY-BACKLOG.md`.

### Notes
- The In-store badge links to the Shopify **admin** product page (by id), matching the
  existing import-page pattern. A storefront `/products/{handle}` link would need the handle
  persisted on the products table (not stored today) — tracked as a follow-up.

## [0.5.20.0] - 2026-06-06

### Changed
- **Replaced Plausible with Umami Cloud** for storefront analytics (preview copy theme
  `160059195497`). Plausible costs 9 $/mo minimum; Umami Cloud is free up to 100k events/mo
  with the same guarantees — cookieless, Loi 25/RGPD/PIPEDA compliant, no cookie banner.
  - Umami `cloud.umami.is/script.js` in `<head>`. The website-id is read from `.env.local`
    (`UMAMI_WEBSITE_ID`); until Mat sets it, a clearly-marked `UMAMI_WEBSITE_ID_PLACEHOLDER`
    ships and the migration script warns loudly.
  - The 4 custom events were migrated off Plausible: **Hero CTA** and **Messenger Click** now
    use `data-umami-event` on the `<a>` links; **Sticky ATC** and **Add to Cart** use
    `umami.track()` in JS (Sticky tracks before its full-page POST, with a 500 ms failsafe;
    Add to Cart is scoped to Dawn `<product-form>`). Unlike Plausible, Umami shows custom
    events automatically — no manual goal creation.
  - Sidebar "Analytics" link now opens `https://cloud.umami.is`.

### Removed
- `docs/PLAUSIBLE-SETUP.md` and `scripts/apply-plausible.mjs` (replaced by
  `docs/UMAMI-SETUP.md` and `scripts/apply-umami.mjs`). All `window.plausible()` /
  `plausible-event-name` references removed from the theme.

### Notes
- Theme edits are on the unpublished preview copy `160059195497`. Umami only reports once the
  theme is published and a real `UMAMI_WEBSITE_ID` is set — verify via Umami's Realtime view
  after setup (see `docs/UMAMI-SETUP.md`). Migration driven by the idempotent
  `scripts/apply-umami.mjs` (reads creds only from gitignored `.env.local`).

## [0.5.19.0] - 2026-06-06

### Added
- **Plausible Analytics** on the storefront (preview copy theme `160059195497`). Cookieless,
  RGPD/PIPEDA/Loi 25-compliant analytics — no cookie banner needed. Auto-tracks page views
  plus four custom click goals: **Hero CTA** ("Magasinez maintenant"), **Sticky ATC**
  ("Acheter maintenant"), **Messenger Click** (floating chat button), and **Add to Cart**
  (product page). Single domain `ameublodirect.ca`.
- **"Analytics" link** in the aosom-sync sidebar opening the Plausible dashboard in a new
  tab (hidden from the reviewer role).
- **`docs/PLAUSIBLE-SETUP.md`** — setup guide for Mat: create the account, add the domain,
  verify the script, and configure the four custom-event goals.

### Notes
- `<a>` links (Hero, Messenger) use Plausible tagged events. The **Sticky ATC** button does
  a full-page POST to checkout, so its goal is sent in JS before submit (with a 500 ms
  failsafe) to avoid losing the event to page-unload. **Add to Cart** is scoped to Dawn
  `<product-form>` adds to avoid double-counting.
- Theme edits are on the unpublished preview copy `160059195497`. Plausible only reports
  once the theme is published; verify via Plausible's "Verify installation" after publish.
  Integration is driven by the idempotent `scripts/apply-plausible.mjs` (reads creds only
  from gitignored `.env.local`).

## [0.5.18.0] - 2026-06-05

### Changed
- **Homepage hero, carousels and a new deals strip** (preview copy theme `160059195497`
  only). The hero headline now keeps a space between its two sentences on desktop, where
  the line break is hidden — it reads "Meublez votre espace. Livraison gratuite au Canada."
  on one line instead of running together (FR + EN).

### Added
- **"🔥 Meilleures offres du moment" / EN "🔥 Best deals right now"** carousel on the
  homepage, right under the trust bar, showing the Rabais/Sale collection (12 products) so
  visitors see discounts immediately. Title is bilingual via theme translations.
- **Infinite-swipe carousels.** The homepage product carousels now loop: swiping to the end
  wraps seamlessly back to the start so shoppers can keep discovering products. Implemented
  as a passive clone buffer (clones are `inert` — never clickable or focusable, so no double
  cart-adds), with the slider's "1 / N" counter hidden.

### Notes
- Theme edits are on the unpublished preview copy `160059195497`, pending on-device
  validation before publish. Operational scripts that drive these edits live under
  `scripts/` and read credentials only from gitignored `.env.local`.

## [0.5.17.0] - 2026-06-05

### Changed
- **Homepage polish** (preview copy theme `160059195497` only; the live theme was not
  touched). Hero text now sits in the upper, readable zone instead of the dark center of
  the photo: vertical alignment moved to `flex-start`, padding-top 10% desktop / 15% mobile,
  and a top-to-bottom gradient overlay so the headline reads on the upper third. The
  "Pourquoi nous choisir" section no longer shows Dawn's default "Texte du bouton" button
  (`button_label` is now explicitly blank). Both homepage carousels ("Mobilier extérieur
  populaire", "Coups de cœur") now show 16 products with the desktop slider enabled, so
  shoppers can swipe through more of the catalogue. (Dawn's native slider has no infinite
  loop, so swipe-carousel was enabled instead.)

### Added
- **"Rabais" / EN "Sale" smart collection** (`/collections/rabais`, 29 products) surfacing
  any product with a struck-through `compare_at_price` or a `sale`/`rabais` tag, sorted by
  best-selling. Added first in the main navigation as "Rabais 🔥" / "Sale 🔥" to make
  discounts discoverable. Collection and menu are global Shopify objects, so they appear on
  the live storefront, not only the preview copy.

### Fixed
- **Blog articles no longer render literal ```` ```html ```` markers.** The AI generator
  wrapped each article's HTML in a markdown code fence; the fence markers showed as visible
  text at the top and bottom of every post. Stripped the fences from 16 affected articles
  (5 published, 11 drafts) and hardened `/api/blog/generate` to strip any code fence inside
  the model's `bodyHtml` before saving, so future articles stay clean.

## [0.5.16.0] - 2026-06-05

### Added
- **Synchronized bilingual blog.** The weekly blog cron now publishes a translated PAIR:
  FR (`/blogs/actualites`) + EN (`/blogs/blog`) on the SAME subject, sharing one Unsplash
  photo set per run. New `src/lib/blog-topics.ts` holds 12 index-aligned bilingual topics
  plus pure, unit-tested weekly selection (`tests/blog-topics.test.ts`, 13 tests).
  `/api/blog/generate` accepts an optional pre-fetched `images` set so both languages
  render identical photos; it self-fetches when none is supplied (backward compatible).

### Security
- **Authentication on mutating API routes** (`/cso` P1). Added `isAuthenticated()` guards
  to `/api/import/push`, `/api/import/queue`, `/api/import/generate`, `/api/sync/trigger`,
  and `/api/collections/sync`, which were previously reachable without auth on a
  publicly-served deployment (Claude cost amplification, arbitrary Shopify writes, sync
  triggering). Dashboard flows are unaffected (same-origin cookie). Remaining P2/P3 items
  tracked in `docs/SECURITY-BACKLOG.md`.

## [0.5.15.0] - 2026-06-04

### Added
- **Storefront theme overhaul** (preview copy theme `160059195497` "Copie de Trade v2";
  the live theme `141533905001` was never touched). Bilingual FR/EN B2C storefront:
  light-scheme header with bilingual logo + sofa favicon, lifestyle homepage
  (hero, storytelling, 6-collection grid, "Pourquoi nous choisir", "Comment ça marche",
  blog teaser, newsletter, trust banners), B2C product page (variant picker, quantity,
  buy buttons, trust badges, sticky add-to-cart, accordions), filtered collections
  (4-col / 24-per-page), and a custom bilingual 404. Copper `#C17F3E` palette throughout.
  i18n via `request.locale.iso_code` (custom-liquid) + `translationsRegister` (native sections).
  The theme lives in Shopify (Admin Assets API); `docs/theme-overhaul.md` is the audit trail.
- `scripts/vectorize-logos.ts` — logo vectorization tool (webp → sharp → potrace → SVG),
  plus generated `Logo/` assets (bilingual PNG logos, favicons) and `potrace` dev dependency.
- `docs/BACKLOG.md` — P2 follow-up: synchronize FR/EN blog generation onto the same topic.

### Changed
- Review messaging made honest while Judge.me has 0 reviews: announcement slide 2 →
  "Laissez-nous votre avis après votre achat" CTA, product badge → "Avis clients Judge.me"
  (dropped "vérifiés"). Revisit once reviews accrue.

## [0.5.14.0] - 2026-06-04

### Changed
- **Re-enabled `new_product` social drafts.** A successful product import now fires a
  bilingual social draft again (`importToShopify` → `triggerNewProduct`). The trigger was
  disabled while waiting for image support; that infra is now in place — `pickRandomImages`
  captures the Aosom product photos into `image_urls`, and the publisher falls back to
  `products.image1` (JOIN) so every product post carries an image. Drafts are created in
  `status='draft'` (review-pending) — nothing is auto-published.
- **Re-enabled the daily `stock_highlight` cron.** `/api/cron/social` now calls
  `triggerStockHighlight()` (was a no-op) to generate one highlight draft per day from a
  random eligible product. Returns `skipped` when no product is eligible, `500` on failure.

### Added
- `tests/cron-social.test.ts` — auth, success, no-eligible-product, and failure paths for
  the stock_highlight cron.
- `tests/import-pipeline.test.ts` — asserts a `new_product` draft fires with the primary SKU
  after a successful import.

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
