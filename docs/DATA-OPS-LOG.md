# Data Operations Log

Audit trail for manual/destructive operations against the production Turso database.
Each entry records the date, the exact rules, and the exact row counts affected.

## 2026-06-06 — Backfill products.shopify_product_id + shopify_handle (SKU match)

Ran after the read-only dry-run (`scripts/shopify-handle-backfill-diagnostic.mjs`) was
validated by Mat. The catalog only had 74 rows with a `shopify_product_id` (imports never
persisted it), so the dashboard "In store" badge under-counted; this links the catalog to
Shopify by SKU and records the storefront handle.

**Procedure:**
1. Added the `products.shopify_handle` column (it predated the PR #87 migration in prod;
   `ALTER TABLE products ADD COLUMN shopify_handle TEXT`, idempotent).
2. Fetched all Shopify products (`GET /products.json`, paginated, ~2 req/sec):
   **597 products / 1,237 variant-SKU mappings**.
3. For each variant SKU: `UPDATE products SET shopify_product_id = ?, shopify_handle = ?
   WHERE sku = ?`.

**Result:**
| Metric | Value |
| --- | --- |
| Shopify products fetched | 597 |
| SKU mappings attempted | 1,237 |
| Catalog rows matched/updated | **969 distinct** (74 → 969) |
| Skipped (SKU not in catalog) | 6 |

**⚠ Data-quality note:** many SKUs appear on **multiple Shopify products** (duplicate
products sharing a SKU). The backfill is last-write-wins per SKU, so a duplicated SKU maps
to whichever Shopify product was fetched last. The handle/link still resolves to a valid
product, but the duplicate products in Shopify are worth cleaning up separately.

## 2026-06-06 — Purge stale + broken facebook_drafts

Ran after a read-only dry-run (`scripts/drafts-purge-diagnostic.mjs`) was validated by Mat.
Applied as a single atomic write transaction.

**Rules (status `draft` only for rule a; rules b/c by explicit id):**
- (a) `trigger_type IN ('new_product','stock_highlight') AND status='draft' AND created_at < now-30d`
  — note: `created_at` is a UNIX epoch integer, so the threshold used
  `cast(strftime('%s','now','-30 days') as integer)`, **not** `datetime('now','-30 days')`.
- (b) draft `id = 352` — empty caption (incomplete generation).
- (c) draft `id = 308` — saved LLM error text ("Je ne vois pas les variables {{season}}…").

**Deleted (exact `rowsAffected`):**
| Rule | Rows |
| --- | --- |
| (a) stale product drafts > 30d | 284 |
| (b) id 352 (empty) | 1 |
| (c) id 308 (LLM error) | 1 |
| **Total** | **286** |

**Guarantee:** rule (a) targets only the two product trigger types, so **no
`content_template` draft was removed except the two explicit ids** (#352, #308).
`content_template` drafts went 18 → 16; the 16 remaining are intact for review.

**Post-purge distribution:** 90 rows total, 27 in `status='draft'`
(content_template 16, new_product 5, stock_highlight 6).
