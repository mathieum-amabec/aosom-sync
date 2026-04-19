# Changelog

All notable changes to Aosom Sync will be documented in this file.

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
