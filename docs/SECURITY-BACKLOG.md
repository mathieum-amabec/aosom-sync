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
**Disclaimer:** `/cso` is an AI-assisted scan that catches common patterns. It is not a
substitute for a professional penetration test. For production systems handling PII or
payments, engage a qualified security firm.
