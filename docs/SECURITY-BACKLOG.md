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
**Disclaimer:** `/cso` is an AI-assisted scan that catches common patterns. It is not a
substitute for a professional penetration test. For production systems handling PII or
payments, engage a qualified security firm.
