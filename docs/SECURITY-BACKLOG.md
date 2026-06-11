# Security Backlog

Findings from `/cso` (CSO security audit). P0/P1 are fixed inline; P2/P3 tracked here.
Audit date: 2026-06-05. Mode: daily (8/10 confidence gate). Stack: Next.js / TypeScript / Turso.

## Fixed (P1) — see commit "fix(security): address /cso findings"

- **Unauthenticated mutating API routes.** `POST /api/import/push`, `/api/import/queue`,
  `/api/import/generate`, `/api/sync/trigger`, `/api/collections/sync` had no auth (rate
  limiter only). The deployment is publicly reachable (`/api/pixel/script` is served to
  browsers by design), so an external attacker could burn Anthropic credits (cost
  amplification), push arbitrary `content` into the Shopify store via a known/guessable
  `jobId`, or trigger heavy catalog syncs. **Fix:** added `isAuthenticated()` cookie guard
  → 401 for unauthenticated callers. The dashboard keeps working (same-origin browser fetch
  sends the httpOnly session cookie). Verified: these endpoints have no server-to-server
  internal callers (cron uses its own `/api/cron/*` routes with Bearer-token auth).

## P2 — Medium (do next)

### P2-1: Unauthenticated read-only API routes (information disclosure)
These GET routes return internal business data with no auth:
`/api/catalog`, `/api/insights`, `/api/sync/history`, `/api/sync/health`,
`/api/collections/shopify`, `/api/collections/mappings`, `/api/notifications`.
**Risk:** an attacker who knows the URL can read the product catalog, sync history, and
insights. No mutation, no secrets — business-data exposure only.
**Fix:** same `isAuthenticated()` guard. Intentionally public, leave as-is:
`/api/health`, `/api/pixel/script`, `/api/pixel/install`, `/api/auth`.
**Better fix:** add a Next.js `middleware.ts` matching `/api/:path*` that enforces the
session cookie, with an allowlist for the public routes + `/api/cron/*` (Bearer) +
`/api/blog/generate` (cron or cookie). One guard instead of per-route checks; closes the
whole class so new routes are protected by default.

### P2-2: Dependency — @anthropic-ai/sdk moderate advisory
`@anthropic-ai/sdk` 0.79.0-0.91.0: Insecure Default File Permissions in the Local
Filesystem Memory Tool (GHSA-p7fg-763f-g4gf). **This app does not use the memory tool**
(only `messages.create`), so the vulnerable path is not reached. Bump to a patched 0.x when
convenient; verify the `messages.create` API is unchanged. Do NOT `npm audit fix --force`
(it jumps to 0.100.1, a breaking major).

### P2-3: Dependency — postcss XSS via Next.js (build-time, transitive)
`postcss <8.5.10`: XSS via unescaped `</style>` in CSS stringify (GHSA-qx2v-qp2m-jg93),
pulled transitively by `next`. Build-time tooling, not a runtime user-input path.
**Fix:** bump Next.js to a minor that ships patched postcss. Do NOT `npm audit fix --force`
— it proposes downgrading Next.js to 9.3.3, which would break the app.

### P2-4: Mutating routes authenticate but don't enforce admin role
The P1 fix gates the mutating routes on `isAuthenticated()` (any valid session). The RBAC
model (`isPathAllowedForRole`, asserted in `tests/auth-rbac.test.ts`) marks
`/api/sync/trigger` and `/api/import/push` as admin-only — a `reviewer` session should not
reach them. The reviewer is a trusted lower-privilege internal user (not the external threat
actor the P1 closed), so this is hardening, not a hole. **Fix:** check
`getSessionRole() === "admin"` (or reuse `isPathAllowedForRole`) on the admin-only routes,
ideally in the same `middleware.ts` proposed in P2-1.

## P3 — Low / informational

### P3-1: LLM output not sanitized before Shopify post
`/api/blog/generate` inserts Claude-generated `bodyHtml` into a Shopify draft article with
no server-side HTML sanitization. Inputs are trusted today (cron uses a fixed topic list;
manual generation is now admin-only), and the system prompt forbids `<script>`/`<img>`.
**Defense in depth:** sanitize the Claude HTML (allowlist tags: h2/h3/p/ul/li/figure/
figcaption/a/img) before `createBlogArticle`, so a future prompt-injection or model slip
can't store active markup on the storefront blog.

---

## Audit 2026-06-06 — branch `feature/dashboard-ui-cso` (daily, 8/10 gate)

Scope: full audit + the dashboard in-store-indicator diff. **No new P0/P1.** Most candidate
findings were dismissed on active verification (see below) — the auth model is sound.

### Verified clean (active verification dismissed these)
- **Auth model is centralized and solid.** `src/proxy.ts` is the Next.js 16 middleware
  (the framework renamed `middleware.ts` → `proxy.ts` in v16). Its `config.matcher` runs on
  every non-static route and redirects to `/login` unless a valid session cookie is present,
  with an explicit `PUBLIC_PATHS` allowlist (`/login`, `/privacy`, `/api/auth`, `/api/cron`,
  `/api/health`, `/api/social/content`, `/api/pixel/script`) and a reviewer-role 403 gate.
- **SQL injection: none.** Dynamic `UPDATE` builders (`updateImportJob`, the facebook_drafts
  updater) whitelist column names (`IMPORT_JOB_COLUMNS.has(key)` / `allowed.has(key)` → throw)
  and pass all values as `?` args. Dynamic `WHERE` clauses are built from constant fragments
  with parameterized args.
- **XSS: none.** Only one `dangerouslySetInnerHTML` (`import/page.tsx:528`) and it is
  `DOMPurify.sanitize()`-wrapped. No `eval`/`Function`/`child_process`. No CORS wildcard.
- **Public LLM route is gated.** `/api/social/content/generate` is proxy-allowlisted but the
  handler itself requires a valid session OR a `CRON_SECRET` Bearer (else 401/403) — no
  unauthenticated Anthropic cost amplification.
- **`/api/pixel/script`** (public, serves JS to the storefront) validates the pixel id as
  digits-only and reads it from a trusted env var.
- **Secrets:** no secret patterns in git history; `.env*` is gitignored; nothing tracked.
- **The diff is clean.** `src/lib/insights.ts` builds `https://admin.shopify.com/...` + a
  numeric Shopify product id, rendered via React-escaped `href` (+ `rel="noopener noreferrer"`
  on the new tab) — no injection. The id originates from our DB, not user input.

### Status update on prior items
- **P2-1 (unauthenticated read routes) — RESOLVED.** The "Better fix" it proposed (a single
  middleware enforcing the session cookie with a public allowlist) now exists as
  `src/proxy.ts`. Verified `/api/catalog`, `/api/insights`, `/api/sync/history`,
  `/api/notifications`, `/api/collections/*` are NOT in `PUBLIC_PATHS`, so an unauthenticated
  request is redirected to `/login` before reaching the handler. Leaving the per-handler
  notes for history; the hole is closed.

### New P3 — Low / informational
- **P3-2: 3 moderate npm advisories.** `npm audit --omit=dev` reports 3 moderate (no
  high/critical). Transitive/tooling-level, no known exploit path into the app. **Action:**
  run `npm audit` periodically and bump when non-breaking fixes land. Not blocking.
- **P3-3: SSRF hardening on image fetch.** `src/lib/image-composer.ts:47` does `fetch(url)`
  where `url` comes from the Aosom CSV feed (also `src/app/api/cron/blog/route.ts:79`). The
  feed is trusted and these run server-side (import/cron), so this is not exploitable today.
  **Defense in depth:** before fetching, enforce `https?:` scheme and block private/loopback/
  link-local IP ranges (169.254.169.254 metadata, 10/8, 192.168/16, 127/8), so a compromised
  or MITM'd feed can't pivot `fetch` at internal/metadata endpoints during composition.

---

## Audit 2026-06-07 — branch `fix/cso-review-june` (daily, 8/10 gate)

Scope: full audit, focus on the public (unauthenticated) attack surface and the merged
feed code (`/api/feeds/{google,pinterest,meta,meta-xml}`). Independent verification via a
read-only security subagent. **1 P1 fixed inline; 1 P2 + 1 P3 tracked below.**

### Fixed (P1) — this branch
- **Non-constant-time cron-secret comparison on a public LLM endpoint.**
  `src/app/api/social/content/generate/route.ts:127` gated the cron path with
  `authHeader === "Bearer " + cronSecret` (`===`), a timing oracle on the secret, while all
  8 other cron routes use `crypto.timingSafeEqual`. The route is proxy-allowlisted under
  `/api/social/content` (public) and triggers paid Anthropic calls, so its auth gate must be
  constant-time. **Fix:** replaced the inline `===` with a `verifyCronSecret()` helper
  matching the rest of the codebase (length check + `timingSafeEqual`, fail-closed on missing
  `CRON_SECRET`). The session-auth fallback is unchanged.

### New P2 — Medium (do next)
### P2-5: `/api/image-preview` redirect not scheme/host-validated — RESOLVED (fix/image-preview-ssrf)
**RESOLVED:** the fallback now validates the target with `assertPublicHttpsUrl` + an
explicit host allowlist (`cdn.shopify.com`, `img-us.aosomcdn.com`, `images.unsplash.com`)
before redirecting; non-allowlisted/non-https targets return `502`. Covered by
`tests/image-preview-route.test.ts`. Original finding below for history.
On composition failure, `src/app/api/image-preview/route.ts:88` does
`NextResponse.redirect(productImageUrl, 302)` where `productImageUrl` is `products.image1`
(populated from the Aosom CSV sync). The route is public and keyed by `sku`. Today the value
is supplier-sourced (not directly attacker-controlled), so this is not exploitable — but if
the Aosom feed were compromised, or a future import path let arbitrary image URLs into the
table, this becomes an unauthenticated open redirect. **Fix (one line):** call the already-
exported `assertPublicHttpsUrl(new URL(productImageUrl))` before the redirect; on failure
return `502` instead of redirecting. Reuses the same guard `downloadImage` already applies.

### New P3 — Low / informational
### P3-4: `/api/health` exposes exact version for fingerprinting — RESOLVED (fix/health-version-leak)
**RESOLVED:** the `version` field was removed from the public `/api/health` payload;
`status`/`db`/`lastSync` remain for monitoring. No more exact-build fingerprinting.
`src/app/api/health/route.ts` returns `version: pkg.version` (e.g. `0.5.28.0`) unauthenticated.
Useful for ops monitoring, but lets an attacker fingerprint the exact build to correlate
against dependency CVEs. **Fix (optional):** drop `version` from the public payload, or gate
it behind a secret query param. Accept-risk is reasonable if the ops value outweighs recon.

### Status updates on prior items
- **P3-3 (SSRF hardening on image fetch) — RESOLVED (PR #90).** `downloadImage`
  (`src/lib/image-composer.ts`) now enforces `https:`, re-validates the internal-host
  denylist on every redirect hop, times out (15s), and caps download size (15MB); the
  compositor sets sharp `limitInputPixels`. The exact defense-in-depth this item asked for.

### Verified clean (active verification)
- **Feeds:** all interpolated product data passes through `escapeXml()`; `availability`/
  `condition` are hardcoded enums, category id is an integer from an internal allowlist; no
  request query params reach feed generation; error path returns only "Feed temporarily
  unavailable" (no stack/env leak).
- **SQL:** all `db.execute`/`db.batch` parameterized; dynamic `orderBy` uses a `switch`
  allowlist. **Session:** HMAC-SHA256 with constant-time compare + expiry. **Secrets:** none
  hardcoded; `.env*` gitignored; clean git history. **LLM:** no public request parameter
  reaches a Claude system prompt without a DB-validation step.

## Audit 2026-06-08 — branch `main` (daily, 8/10 gate)

Scope: recent video feature merges (#113 dashboard, #114 FFmpeg pipeline, #115 video-serve
+ furnishdirect domain script) and the new public route. **No P0/P1 findings.**

### Verified clean (active verification)
- **FFmpeg engine** (`src/lib/video-engines/ffmpeg-slideshow.ts`): invoked via
  `spawn(binary, args, …)` with an **argument array, not a shell string** — product
  names/SKUs/paths can't inject shell commands. Binary resolved from `FFMPEG_BIN` env →
  `ffmpeg-static` → system PATH (no user input). No command injection.
- **`/api/video-serve/[id]`** (public, allow-listed in `proxy.ts`): the only request input
  is the numeric `id` (validated `> 0`). `video_url`/`video_path` come from the DB row
  (pipeline-set), never the request — no path traversal, no open redirect from user input.
  Range parsing rejects unsatisfiable ranges with 416.
- **`/api/videos` + `/api/videos/[id]`**: `isAuthenticated()`-gated; writes (POST/PATCH/
  DELETE) additionally blocked for the `reviewer` role. POST accepts only
  engine/contentType/locale/productSkus — `video_path`/`video_url` are NOT settable by the
  client, closing the traversal/redirect surface at the source.
- **Cron routes** `blog`, `csv-precache`, `sync-shopify`: all self-gate via
  `verifyCronSecret` (`Bearer ${env.cronSecret}`) despite `/api/cron` being public — cleared.
- **Scripts** (`bind-furnishdirect-domain.mjs` + the in-tree klaviyo scripts): no hardcoded
  secrets; token read from `.env.local` via `loadEnv()`. `.env*` gitignored; clean history.

### New P3 — Low / informational (defense-in-depth)
### P3-5: `/api/video-serve` streams `video_path` with no directory containment
`src/app/api/video-serve/[id]/route.ts:57-100` calls `fsp.stat(job.video_path)` +
`createReadStream(job.video_path)` directly. Currently safe — `video_path` is written by the
(future) generation pipeline, never by a request — so there is no traversal path today.
**Risk only materializes** if a future pipeline bug or a new admin endpoint lets an arbitrary
path land in `video_jobs.video_path`; the public route would then stream that file
(e.g. `.env.local`) to anyone. **Fix (cheap):** resolve `video_path` and assert it is inside
a dedicated videos directory (e.g. `path.resolve` startsWith the blob/tmp video root) before
streaming. Mirrors the containment discipline already applied elsewhere.

### P3-6: `/api/video-serve` 302-redirect to `video_url` not host-allow-listed
`route.ts:52-53` redirects to `job.video_url` after only an `http(s)` scheme check. This is
the **same class as P2-5** (`/api/image-preview`), which was RESOLVED by allow-listing the
redirect host (`fix/image-preview-ssrf`). video-serve did not adopt that pattern. Safe today
(`video_url` is pipeline-set: Vercel Blob / Kling), but a poisoned DB value would make this
public route an open redirect. **Fix:** reuse the image-preview host allowlist
(`cdn.shopify.com`, blob/CDN hosts) before `NextResponse.redirect`, consistent with P2-5.

---

## Audit 2026-06-09 — branch `feature/pinterest-en-judgeme` (daily, 8/10 gate)

Scope: the merges landed since the 2026-06-08 audit — #125 cron instrumentation
(`blog`/`content`/`csv-precache` wrapped in `trackCron`), #126 Pinterest EN feed + Judge.me
avis page, #127 video pipeline rewire (Kling render via `/api/videos/generate` → `video_jobs`).
Plus the live-theme Shop Pay block edit made this session. **No P0/P1 findings.**

### Verified clean (active verification)
- **All 9 cron routes self-gate.** `verifyCronSecret` (`length` check + `crypto.timingSafeEqual`)
  is present and called in `sync`, `sync-refresh`, `sync-finalize`, `sync-shopify`, `social`,
  `social-scheduled`, `blog`, `content`, `csv-precache` — every route under the public
  `/api/cron` prefix returns 401 without the Bearer. `env.cronSecret` throws when `CRON_SECRET`
  is unset (`config.ts:26`), so a missing secret fails closed (500/throw, never "Bearer
  undefined" auth) regardless of whether a given route wraps the access in try/catch.
- **New paid route `/api/videos/generate` (#127) is gated.** `route.ts:131-135` requires a
  valid session and blocks the `reviewer` role before any FFmpeg/Kling render — no
  unauthenticated Kling/Anthropic cost amplification.
- **`social/content/generate` + `generate-weekly-mix`** remain self-gated (session OR cron
  Bearer → 401/403) despite the public `/api/social/content` proxy prefix.
- **Feeds (#126 Pinterest EN):** public by design (Google/Meta/Pinterest pull them); they
  expose only catalog data already public on the storefront. No request params reach feed
  generation; product data is `escapeXml()`-escaped (per the 2026-06-07 verification, pattern
  unchanged).
- **price-alert (public, cross-origin):** strict `ALLOWED_ORIGINS` allowlist, per-IP rate
  limit, email/sku validation, and the baseline price is taken **server-side** from the DB
  (client `price` is sanity-checked only) — a client can't post an inflated price to trigger a
  spurious drop alert. Double opt-in keeps alerts off non-confirmed addresses.
- **Secrets:** no hardcoded secret patterns in `src/` or `scripts/`; `.env.local` is untracked;
  `.gitignore` covers `.env*` + `.env*.local`; no env file in git history.
- **Live-theme Shop Pay edit (this session):** the new `shop_pay_finance` custom_liquid is
  static branded markup + a CSS rule for the native `<shopify-payment-terms>` widget. No user
  input, no script, no external fetch. The removed block had computed a price ÷ 4 amount; the
  replacement leans on Shopify's native widget for real figures. No new surface.

### Persistent (still open from 2026-06-08, re-confirmed)
- **P3-5: `/api/video-serve` streams `video_path` with no directory containment.** Still
  `fsp.stat`/`createReadStream(job.video_path)` directly (`route.ts:57-100`). Safe today
  (pipeline-set path), but add a `path.resolve` startsWith-videos-root assertion before
  streaming. Unchanged from prior audit.
- **P3-6: `/api/video-serve` 302-redirects to `video_url` with only an http(s) scheme check**
  (`route.ts:52-53`). Same class as the RESOLVED P2-5 (`/api/image-preview` host allowlist);
  video-serve still hasn't adopted the host allowlist. Reuse `assertPublicHttpsUrl` + CDN/blob
  host allowlist before redirecting.

### New P3 — Low / informational
### P3-7: `verifyCronSecret` is copy-pasted into 9 cron routes
Each cron route defines its own identical `verifyCronSecret`. They agree today, but a future
cron route can ship without the check (the `/api/cron` prefix is public, so a forgotten gate =
an open paid/mutating endpoint, not a redirect to /login). **Fix (defense in depth):** extract
one `lib/cron-auth.ts` `verifyCronSecret(header)` helper and import it everywhere, so "is this
cron route authenticated?" has a single answer and new routes opt into it by import. Two of the
copies (`social-scheduled`, `social/content/generate`) already wrap `env.cronSecret` in
try/catch; the shared helper should adopt that fail-closed form for all.

---

## Audit 2026-06-11 — daily mode (code surface since 2026-06-08)

Scope: src changes merged in PRs #149–#155 (PDP redesign, home-video, strip-leading-heading,
Enfants menu/swatches, phase-6 voice, catalog routes). Theme work this period is Shopify-side
(no app surface). Gate: 8/10 confidence.

### Clean (verified this run)
- **ReDoS — `stripLeadingHeading` (`src/lib/html-utils.ts:18`):** regex
  `/^\s*<h([1-3])\b[^>]*>[\s\S]*?<\/h\1>\s*/i` is `^`-anchored (single start position),
  the inner `[\s\S]*?` is lazy with a required backreferenced close tag, and there is no
  nested/overlapping quantifier. No catastrophic backtracking on adversarial `body_html`. Safe.
- **`/api/video-serve/[id]` (now PUBLIC, `proxy.ts` allowlist):** `id` is `parseInt`+positive-int
  validated; `video_path`/`video_url` come from the DB row (pipeline-controlled, never request),
  redirect target is `isHttpUrl`-checked. Videos are public marketing assets (Graph API fetches
  them). No IDOR of sensitive data, no path-traversal from request input. (Note: the DB-set
  `video_path` containment + redirect host-allowlist hardening remain tracked as P3-5/P3-6.)
- **`/api/catalog/stats`:** no inline auth but gated by `proxy.ts` (not in PUBLIC_PATHS); returns
  only aggregate `COUNT(*)`s. No request params reach the query. Consistent with `/api/catalog`.
- **Secrets:** no hardcoded secret patterns in src changes since 2026-06-07; scan clean.

### New P2 — SSRF defense-in-depth gap
### P2-6: `classifyImageBackground` fetches image URLs with no SSRF guard
`src/lib/variant-merger.ts:289` does a raw `fetchImpl(url, { signal })` on product image URLs to
measure border whiteness during import. Unlike the hardened `downloadImage`/`assertPublicHttpsUrl`
path (`image-composer.ts:44–107`), it does **not**: enforce HTTPS, deny internal/link-local hosts
(`169.254.169.254`, `127.*`, `10.*`, `.internal`…), or re-check redirect hops (default `fetch`
auto-follows 30x, so even a public HTTPS URL can 302 into the internal network). **Why only P2,
not P1:** the URL source is the Aosom supplier CSV (semi-trusted, not arbitrary end-user input),
the SSRF is **blind** — only a 1-trit classification (`white_bg`/`lifestyle`/`unknown`) is ever
returned, never the response body — and it is GET-only on a manually-triggered import path.
**Fix:** call `assertPublicHttpsUrl(new URL(url))` before the fetch and pass `redirect: "manual"`
with a per-hop re-check (or refactor `classifyImageBackground` to reuse `downloadImage`'s buffer
under the existing size/timeout caps). Trivial — the guard helper is already exported.

---
**Disclaimer:** `/cso` is an AI-assisted scan that catches common patterns. It is not a
substitute for a professional penetration test. For production systems handling PII or
payments, engage a qualified security firm.
