# Data Operations Log

Audit trail for manual/destructive operations against production data stores
(Turso DB + Shopify). Each entry records the date, the exact rules, and the exact counts.

## 2026-06-06 — Delete active duplicate Shopify products + final re-backfill

Second (and final) dedup pass, validated by Mat. Same clustering + keeper rule as the draft
pass; this time deleting the remaining **active** non-keeper duplicates. Each delete was
hard-guarded so a cluster keeper is never removed.

**ÉTAPE 1 — deleted active non-keeper duplicates** (`DELETE /products/{id}.json`, ~2 req/sec,
logged id + title + SKUs):
| Metric | Value |
| --- | --- |
| Active duplicates deleted | **62** |
| Failed | 0 |
| **Keepers touched** | **0** |

Products went 549 → **487**.

**ÉTAPE 2 — re-backfill (3rd time):** re-ran the SKU match on the 487 survivors so the ~28
links that referenced now-deleted products repoint to keepers. Post-state: **969** catalog
rows carry both `shopify_product_id` and `shopify_handle`.

**ÉTAPE 3 — final verification (read-only):** **0 duplicate SKUs, 0 clusters.** The catalog
is fully deduplicated (487 unique products).

## 2026-06-06 — Delete draft duplicate Shopify products + re-backfill handles

Conservative dedup pass, validated by Mat after the read-only diagnostic
(`scripts/shopify-duplicate-products-diagnostic.mjs`). Duplicate products (re-imports
sharing variant SKUs) were grouped into clusters; one keeper per cluster
(rule: active > most-recent `updated_at` > DB-referenced handle).

**ÉTAPE 1 — deleted ONLY `draft` non-keeper duplicates** (`DELETE /products/{id}.json`,
~2 req/sec, each delete hard-guarded to `status === 'draft'`):
| Metric | Value |
| --- | --- |
| Draft duplicates deleted | **48** |
| Failed | 0 |
| **Active products touched** | **0** |

Products went 597 → **549**. No active/published product was deleted.

**ÉTAPE 2 — re-backfill** (`scripts/shopify-handle-backfill-diagnostic.mjs` logic, applied):
re-ran the SKU → `shopify_product_id` + `shopify_handle` match on the 549 survivors so the
~40 catalog links that referenced now-deleted drafts repoint to surviving products.
Post-state: **969** catalog rows carry both `shopify_product_id` and `shopify_handle`.

**ÉTAPE 3 — remaining duplicates (read-only):** 110 duplicate SKUs across **51 clusters**,
all now **active-vs-active** dupes. Fully deduping would require deleting **62 active
(published) products** (28 of which the DB links to) — held for Mat's per-case review,
since deleting published products has storefront/SEO impact. Worst remaining clusters are
mostly raised garden beds / planters and patio swings with 3–4 near-identical active listings.

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
