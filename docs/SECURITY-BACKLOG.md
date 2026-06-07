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
### P2-5: `/api/image-preview` redirect not scheme/host-validated
On composition failure, `src/app/api/image-preview/route.ts:88` does
`NextResponse.redirect(productImageUrl, 302)` where `productImageUrl` is `products.image1`
(populated from the Aosom CSV sync). The route is public and keyed by `sku`. Today the value
is supplier-sourced (not directly attacker-controlled), so this is not exploitable — but if
the Aosom feed were compromised, or a future import path let arbitrary image URLs into the
table, this becomes an unauthenticated open redirect. **Fix (one line):** call the already-
exported `assertPublicHttpsUrl(new URL(productImageUrl))` before the redirect; on failure
return `502` instead of redirecting. Reuses the same guard `downloadImage` already applies.

### New P3 — Low / informational
### P3-4: `/api/health` exposes exact version for fingerprinting
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

---
**Disclaimer:** `/cso` is an AI-assisted scan that catches common patterns. It is not a
substitute for a professional penetration test. For production systems handling PII or
payments, engage a qualified security firm.
