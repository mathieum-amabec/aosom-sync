# Changelog

## [0.1.0.0] - 2026-04-05

Security hardening and quality improvements across the entire Aosom Sync catalog management app.

### Added

- HMAC-signed session tokens with `crypto.timingSafeEqual` verification, replacing the weak hash-based auth.
- DOMPurify sanitization for all HTML content rendered via `dangerouslySetInnerHTML` in the import pipeline preview.
- Domain validation on `AOSOM_CSV_URL` and `SHOPIFY_STORE` environment variables to prevent SSRF.
- Content validation for Claude API responses with field-level type checking and retry on parse failure.
- SQL injection protection via column name allowlist in `updateImportJob`.
- Shared `StatusBadge` component and `timeAgo` utility, extracted from duplicated code.
- Shared `CatalogProduct` and `CatalogResponse` types in `src/types/catalog.ts`.
- Explicit `AUTH_PASSWORD` environment variable requirement (no more default password).
- Input clamping on `page` and `limit` query parameters across all API routes.

### Changed

- All `database.ts` functions are now synchronous (matching `better-sqlite3` behavior), removing misleading `async` signatures.
- Middleware static-asset check narrowed from broad `pathname.includes('.')` to explicit extension allowlist.
- Middleware public path `/api/cron` narrowed to `/api/cron/sync` to prevent unintended bypass.
- Sync engine dry-run mode no longer writes catalog snapshots or price/stock history to the database.
- Sync engine price-change variant lookup uses `Map` for O(1) instead of O(n) per product.
- Shopify rate-limit retry now caps at 3 attempts instead of unlimited recursion.
- Cron endpoint error messages no longer leak internal configuration details.
- Locale changed from `en-US` to `fr-CA` throughout the dashboard (Quebec market).
- Catalog snapshot refresh now runs inside a transaction (atomic delete + insert).

### Fixed

- `timingSafeEqual` now checks buffer lengths before comparison, preventing exception-based timing leaks.
- `refreshCatalogSnapshots` DELETE moved inside the transaction to prevent empty catalog on partial insert failure.
