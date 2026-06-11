# Data Operations Log

Audit trail for manual/destructive operations against production data stores
(Turso DB + Shopify). Each entry records the date, the exact rules, and the exact counts.

## 2026-06-11 — Homepage premium: shipping-mention reduction + category tiles (PREVIEW, no live edit)

All writes on the unpublished preview `160213696617`; live `160059195497` not touched
(`scripts/apply-premium-c1.mjs` / `apply-premium-c2.mjs` are preview-guarded). Read-only audit
first: `docs/homepage-audit.md`.

- **Chantier 1 — "livraison gratuite" 4 → 2 on the home.** Kept the announcement bar
  (`header-group.json`) + `lc_trustbar` reassurance bar. Replaced the two other mentions in
  `index.json`: `lc_hero` H1 2nd line "Livraison gratuite au Canada" → "Satisfaction garantie
  30 jours" (FR+EN); `why_us` first icon (truck "Livraison gratuite") → grid icon "Plus de 490
  produits". Verified: index.json now has 1 "livraison gratuite" (trustbar).
- **Chantier 2 — premium category tiles.** Replaced the native `collection_list` ("Magasinez
  par catégorie", 6 plain collection cards) with a new `cat_tiles` custom-liquid section: a
  responsive grid (3×2 desktop / 2-col mobile) of Unsplash lifestyle tiles with a navy
  `rgba(27,42,74,.5)` overlay, white DM Sans Bold bilingual titles, and `:hover scale(1.02)` +
  lighter overlay. 6 Unsplash images uploaded as preview assets `assets/cat-tile-1..6.jpg`
  (download pings triggered per Unsplash ToS); each tile links to its `/collections/<handle>`.
  `collection_list` removed from sections + order.

QA (`scripts/verify-premium.mjs`): **all ✅** (cat_tiles in, collection_list out, 6/6 tiles
linked + uploaded, navy overlay + hover present, hero/why_us shipping replaced, 2 home
"livraison" mentions, no live liquid error). Promote the preview to publish (it already carries
A3/A4 + prior B-fixes).

## 2026-06-10 — Phase 3: Aosom video ingest (DRY-RUN, no upload/no product change)

Tested the Shopify API path for attaching Aosom MP4s, via
`scripts/aosom-video-ingest-dry-run.mjs` (read-only). **No video uploaded, no product
modified.**

- **Scopes** (`GET /admin/oauth/access_scopes.json`): `write_products` ✅;
  `write_files` ❌ and `read_files` ❌ **missing**.
- **`stagedUploadsCreate(resource: VIDEO)`** tested on 3 top-30 SKUs with a `products.video`
  URL (17/30 have one): `01-0893`, `823-002V80`, `823-010V81`. **All 3 returned valid
  staged targets** (GCS upload URL + `external_video_id` + signed params), no `userErrors`
  — despite the missing file scopes. Product videos go through the **product-media** path
  (`stagedUploadsCreate` + `productCreateMedia`, covered by `write_products`), not the
  Files API.

Report: `docs/aosom-video-ingest-dry-run.md`. Real ingestion (upload bytes +
`productCreateMedia` + poll READY) **NOT executed** — awaiting Mat's validation.

## 2026-06-10 — Phase 2: lifestyle featured-image heuristic (DRY-RUN, no writes)

Ran `scripts/lifestyle-image-dry-run.mts` (read-only) on the **30 top-seller SKUs**
(docs/audit-pdp-video.md §6). For each, compared the current featured image (sync
`selectProductImages`, pos 0) with what the new white-background heuristic promotes
(`classifyImageBackground`: download ≤5s/≤2MB → sharp border-10% near-white ratio; >80% =
white studio bg, <80% = lifestyle; failsafe = keep CSV order).

**Result: 24 / 30 would change featured image** (white studio → lifestyle). 6 already
lifestyle. Current-image classes: 21 `fond_blanc`, 6 `lifestyle`, 3 `inconnu` (analysis
failed on the current pos-0 image; a confirmed lifestyle was promoted instead). Every
*proposed* pos-0 is `lifestyle` — the heuristic never promotes a white-bg shot when a
non-white one exists.

Report: `docs/lifestyle-image-dry-run.csv` (UTF-8 BOM). **No Shopify/DB writes.** New
imports already use the heuristic (import-pipeline); **backfill of existing live products is
NOT done** — awaiting Mat's validation of this dry-run.

## 2026-06-10 — B2/B3 + preview SEO finalize on PREVIEW theme 160213696617 (no live edit)

All writes on the unpublished preview `160213696617`; live `160059195497` not touched
(`scripts/apply-homepage-improvements.mjs` + `apply-preview-seo-finalize.mjs` are preview-guarded).

- **B2 testimonials:** the fabricated "Évaluations de nos clients" multicolumn
  (`multicolumn_eWXcry`, 5 invented reviews incl. 2 "Anonyme") was **removed** from
  `templates/index.json` (section + order). Per Mat's decision — **not** replaced with new
  fabricated named testimonials (deceptive advertising / QC Consumer Protection Act). The real
  Judge.me widget on the home is kept. Judge.me public API returned 401 (no token), so review
  count could not be auto-verified.
- **B3 carousels:** removed the redundant 3rd carousel `featured_collection1` ("Mobilier
  extérieur", manual collection) — it overlapped "Coups de cœur" by **217/≈233 products
  (~93%)**. Kept "Meilleures offres" (`rabais`) + "Coups de cœur" (`coups-de-coeur`, smart).
- **B3 "livraison gratuite" repetition:** home went from 8 mentions to 3. Kept `lc_hero`
  (headline) + `lc_trustbar` (✓ reassurance bar); the structural `why_us` SVG icon kept.
  Removed/reworded in `lc_story2`, `lc_trust`, `lc_howit` (step → "Livraison à domicile"),
  `shop_pay_home` mini-bar, and the all-caps `rich_text` banner.
- **Preview SEO finalize (promotion-safety):** the preview lacked A3/A4 (those were applied to
  the live theme only — promoting the preview would have reverted them). Applied the same
  clean edits to the preview: removed the old duplicate og injection from `layout/theme.liquid`,
  added the `request.page_type == 'index'` og:image branch to `meta-tags.liquid` (asset already
  on preview), and the meta-description index branch in `theme.liquid` + `meta-tags.liquid`.

QA (`scripts/preview-qa.mjs`): **16 ✅ / 0 ❌ / 0 ⚠️**. Report: `docs/preview-qa-report.md`.

## 2026-06-10 — P0 fix: featured-collection pagination on PREVIEW theme (no live edit)

Fixed the Liquid render error on the preview theme `160213696617` introduced by the Phase-1
`where: 'available'` pre-filter: *"Array 'cc_available_products' is not paginateable"*
(`sections/featured-collection.liquid` line 108). The `| where:` filter returns a plain Array,
which `{% paginate %}` rejects.

Fix (`sections/featured-collection.liquid`, PUT 200): restored pagination over
`section.settings.collection.products` (the original working construct, identical to the live
theme) and moved the availability check **inside** the loop:

```liquid
{% paginate section.settings.collection.products by section.settings.products_to_show %}
  {%- for product in section.settings.collection.products limit: section.settings.products_to_show -%}
    {%- if product.available -%} …card… {%- endif -%}
```

Keeps the sold-out-skip intent (moot under dropship `inventory_management: null`, but harmless)
without the non-paginateable array. A full-asset scan confirmed `featured-collection.liquid`
was the **only** file with `cc_available_products` (one shared section file → fixes all
featured-collection instances: Meilleures offres, Coups de cœur, Mobilier extérieur). Verified
via Admin API: 0 `cc_available_products` remain, `paginate` targets `collection.products`,
in-loop `product.available` present. Live `160059195497` NOT touched.

## 2026-06-10 — B4: fix duplicate "500" social-proof numbers on the PREVIEW theme (no live edit)

Target: PREVIEW theme `160213696617` ("Copie de Copie de Trade v2", unpublished). Live
`160059195497` NOT touched (`scripts/apply-social-proof-preview.mjs` hard-aborts otherwise).

Real counts (Admin API `products/count.json`): **497 active**, 502 total. So "Plus de 500
produits" was actually slightly **overstated** (497 < 500), not understated. Using 497 rounded
down to the nearest ten → **490**.

`templates/index.json` — 6 string replacements (PUT 200), verified by re-read:
- `lc_hero`: "Plus de 500 produits" / "500+ products" → "490".
- `lc_howit`: "catalogue de 500+ produits" / "catalog of 500+ products" → "490+".
- `lc_trust` H2: "Plus de 500 familles canadiennes nous font confiance" (unverifiable +
  duplicate number) → **"Satisfaction garantie 30 jours"** (verifiable via the 30-day return
  policy; EN "30-day satisfaction guarantee"). The section's `<p>` ("Livraison gratuite ·
  Retours faciles · Service québécois") left unchanged.

Verified: all 6 new strings present, 0 stale "500" social-proof strings remain. Visual QA via
admin Theme Preview (`?preview_theme_id=` serves the published theme without a staff session).

## 2026-06-10 — A2: product-card fixes on PREVIEW theme (no live edit)

Target theme: **`160213696617`** (UNPUBLISHED). Live **`160059195497` NOT touched**.
Applied via `scripts/preview-card-fixes.mjs` (idempotent; re-run = 0 changes).

**Theme assets written (2):** `templates/index.json` (3 sections) and
`templates/collection.json` (1 section): `"quick_add": "bulk"` → `"standard"`, which removes
the quantity +/- stepper from product cards (it only renders in bulk mode) while keeping a
single add-to-cart button. Both JSON validated before + after.

**Not applied:** hiding the "Default Title" variant label on cards — a full theme scan found
**no visible `variant.title` render** on cards (only aria-labels, already de-verbosed by the
Phase-1 `fr.json` change). Nothing to guard. **Need an example card URL from Mat** where
"Default Title" is visibly shown, to locate the real source (possibly an app or a metafield).

## 2026-06-10 — B1: Discount credibility audit (DRY-RUN, no writes)

Scanned all **502** Shopify products via Admin GraphQL (read-only, ~2 req/s, 3 pages) for
variants with `compareAtPrice > price`. Per product, the headline discount = the variant with
the **largest** discount %. Bucketed against the store rule (≥10% to show a strikethrough):

| Bucket | Rule | Count |
| --- | --- | --- |
| `remove` | `< 10%` (not credible) | **0** |
| `ok` | `10–40%` | **24** |
| `review` | `> 40%` (defensible?) | **4** |

Only **28 / 502** products carry a compare-at (sale) price. **Nothing to remove** (0 below
10%). The 4 `review` items (highest first): 62.5% (`7736546033769` Serre portable 4 étages),
47.6% (`7736568971369` Gazebo 10×13), 46.9% (`7736553177193` Clôture jardin 152 cm), 46.2%
(`7736550228073` Lampadaire solaire 3 têtes). Whether these are defensible depends on the real
MSRP vs the strikethrough — manual call for Mat.

Report: `docs/discount-audit.csv` (UTF-8 BOM; columns product_id, title, price,
compare_at_price, discount_pct, bucket). Generator: `scripts/discount-audit.mjs` (read-only).
**No product writes performed.** No remediation applied — awaiting Mat's decision.

## 2026-06-10 — A3/A4 finalized on the LIVE theme 160059195497: og:image + home meta description (authorized)

Mat authorized editing the live theme this round. Two SEO changes applied to the LIVE theme
plus cleanup of two ineffective shop metafields.

**Metafields deleted (ineffective):** `global.description_tag` and `global.og_image` shop
metafields had been created but are NOT read by the theme — the storefront renders
`page_description` from Online Store Preferences and og:image from the theme's meta-tags
snippet, neither of which reads these metafields (verified: no render change). Both DELETEd (200).

**og:image (A3) — LIVE:** the real source is `snippets/meta-tags.liquid` (`{% render 'meta-tags' %}`),
which emits og:image from `page_image` (the 488×168 logo on the home). A first attempt that
injected a tag into `layout/theme.liquid` before `content_for_header` produced a duplicate that
rendered AFTER the meta-tags og:image (logo stayed primary), so it was **reverted from backup**.
Clean fix: patched `meta-tags.liquid` with an `{% if request.page_type == 'index' %}` branch so
the home uses `assets/og-image-social.jpg` (1200×630, uploaded to the live theme). Single
og:image tag = our image; verified on fresh cache-busted renders.

**Home meta description (A4) — LIVE:** not settable via the public Admin API (the
`description_tag` metafield is ignored; the home is not a Page resource). Applied via the same
index-branch theme approach: `layout/theme.liquid` `<meta name="description">` and
`meta-tags.liquid` `og_description` now use the FR V1 text when `request.page_type == 'index'`;
all other page types unchanged. Verified: home `<meta name="description">` + og:/twitter
description render the new text on fresh loads.

FR text applied: "Aménagez votre patio et votre jardin pour l'été québécois : mobilier
d'extérieur, BBQ, déco et accessoires, livrés gratuitement partout au Canada."

Backups: `.git/live-theme-liquid-backup*-2026-06-10.liquid`,
`.git/live-meta-tags-backup*-2026-06-10.liquid`. Scripts: `scripts/apply-seo-metafields.mjs`
(metafield attempt), `scripts/apply-og-live-v2.mjs` (og:image), `scripts/apply-meta-desc-live.mjs`
(meta description + metafield delete), `scripts/verify-og-live.mjs`. Storefront edge cache may
serve the old home for a few minutes; validate via the Facebook Sharing Debugger.

## 2026-06-10 — Phase 1: anti-cheap PDP/home fixes on PREVIEW theme (no live edit)

Target theme: **`160213696617`** "Copie de Copie de Trade v2" (UNPUBLISHED). The live
theme **`160059195497` was NOT touched** (the script hard-codes the preview id and refuses
to run against live). Applied via `scripts/preview-pdp-cheap-fixes.mjs` (idempotent; re-run
reports 0 changes / 5 already-applied).

**Theme assets written (5):**
1. `sections/main-product.liquid` — removed the redundant `<h2 class="h1">` title link
   (duplicate title) → single `<h1>`.
2. `locales/fr.json` — `products.product.quantity.decrease/increase` shortened to
   "Réduire/Augmenter la quantité" (dropped "de {{ product }}").
3. `templates/index.json` — `why_us` multicolumn (emoji titles) → `custom-liquid` row of
   thin-line navy (#1B2A4A) inline SVG reassurance icons.
4. `sections/header-group.json` — stripped emojis (🚚🔄🔒⭐) from the two announcement-bar
   blocks.
5. `sections/featured-collection.liquid` — added `| where: 'available', true` pre-filter so
   carousels skip sold-out products.

Each JSON asset validated (parse) before + after write. **Not applied:** literal "##" in
descriptions — 0/502 descriptions contain "##" (read-only scan), nothing to strip; flagged
for Mat. **Awaiting Mat's visual checkpoint** on preview before any live promotion.

## 2026-06-10 — og:image + newsletter dedup on PREVIEW theme 160213696617 (live untouched)

Three Shopify Admin API writes, all on the **unpublished preview** theme
`160213696617` ("Copie de Copie de Trade v2"). The live theme `160059195497` was
**not** touched (script `scripts/apply-og-newsletter-preview.mjs` hard-aborts if the
target id equals live or is not role=unpublished).

- **Asset PUT** `assets/og-image-social.jpg` ← Unsplash `UQXMWJHusQs` cropped to
  1200×630 (`&w=1200&h=630&fit=crop&crop=entropy`). Status 200, 226 057 bytes,
  image/jpeg. Unsplash download ping triggered (status 200) per API ToS.
- **Asset PUT** `layout/theme.liquid` — inserted `<meta property="og:image"
  content="{{ 'og-image-social.jpg' | asset_url }}">` immediately before `</head>`.
  Status 200. (Caveat: coexists with Shopify's `content_for_header` og:image — 2 tags.)
- **Asset PUT** `templates/index.json` — removed section `lc_newsletter` ("Restez à
  l'affût") and its `order` entry; footer `newsletter_DPwWK7` kept. Status 200.

Verification via Admin API reads (`scripts/verify-og-newsletter-preview.mjs`): asset
present, `lc_newsletter` absent from sections+order, og:image line present in
theme.liquid. Public `?preview_theme_id=` render serves the published theme (Shopify
ignores the param without a staff session), so visual QA is done via admin Theme Preview.

## 2026-06-10 — A1: Supplier-brand removal from product titles (DRY-RUN, no writes)

Scanned all **502** products via Admin GraphQL (`products`, read-only, ~2 req/s) for
Aosom house-brand tokens leaking into `title`. Brand set: Outsunny, HOMCOM, Aosom,
Vinsetto, Kleankin, Zonekiz + the rest of the family (Soozier, Qaba, PawHut, Sportnow,
Aiyaplay, Rosefray), word-boundary + case-insensitive. Third-party makers like Teamson
are deliberately excluded.

**Result: 7 titles affected** (6× Outsunny, 1× Aosom). The import pipeline already
strips `[BRAND NAME]` from the other 495.

Cleaning rules applied to the proposed title:
- remove the brand token; collapse double spaces, double commas, edge orphan separators
- **word-joining hyphens preserved** (e.g. "Brise-Vue" is NOT split)
- structure "Type, caractéristique, taille — couleur" kept (no reorder)
- **handles never read or touched** (feed risk)

Report: `docs/brand-cleanup-dry-run.csv` (UTF-8 BOM). Generator:
`scripts/brand-cleanup-dry-run.mjs` (idempotent; dry-run by default, `--apply` to write).

**DECISION (Mat, 2026-06-10):** `vendor` stays **"Aosom"** for all products — we only
strip the brand from the **title**, no vendor change. The report's `vendor_propose` column
therefore equals `vendor_actuel` on every row. The `--apply` mode updates **title only**
(GraphQL `productUpdate`), never vendor, never handle.

**Shopify writes performed this op (2026-06-10, `--apply`, Mat go):** 7 product **titles**
updated via `productUpdate` (7 OK / 0 fail). Vendor and handles untouched. Post-write
re-scan confirms **0** titles still contain a supplier brand.

## 2026-06-09 — Google Customer Reviews: theme-inject REJECTED, app path chosen (NO theme change)

Requested: inject the Google Merchant Center survey opt-in snippet (merchant_id
`5804673777`) into the order-confirmation page of the live theme `160059195497` (PUT a
theme file before `</body>`).

**Did NOT touch the theme.** Investigation showed the prescribed approach cannot work:

- Live theme `160059195497` is **Online Store 2.0** (Trade v2). It has **no**
  `layout/checkout.liquid` (Plus-only) and **no** `sections/order-status.liquid`. Only
  `layout/theme.liquid` + `layout/password.liquid` exist. `templates/customers/order.json`
  is the **customer-account** order page, not the post-checkout "thank you" page.
- Shop plan = **Basic** (non-Plus), country CA (`/admin/api/2025-01/shop.json`).
- The order-confirmation / order-status page is **owned by Shopify Checkout, not the theme**.
  Injecting the snippet into `layout/theme.liquid` would (a) fire on **every** storefront
  page, and (b) render `{{ order.* }}` / `{{ customer.email }}` / `{{ shipping_address.* }}`
  **empty** (those Liquid objects don't exist outside checkout) — GCR would receive no
  order_id/email and fail.
- The legacy injection points (order-status **Additional Scripts** box and
  **ScriptTags** with `display_scope=order_status`) were **disabled by Shopify on
  2025-08-28** as part of the forced checkout-extensibility migration. ~9 months past that
  cutoff, neither fires on the confirmation page.

**Decision (confirmed with Mat):** install via the supported path — the **Google & YouTube**
Shopify channel app linked to Merchant Center `5804673777`, with Customer Reviews enabled in
Merchant Center. No code injection, no theme PUT, no ScriptTag. Runbook:
`docs/GOOGLE-CUSTOMER-REVIEWS-SETUP.md`.

**Shopify writes performed this op:** none (read-only: `themes/*/assets.json`, `shop.json`).

## 2026-06-07 — Deploy double-opt-in price_drop_alert widget to the LIVE theme

Deployed the canonical double-opt-in price-alert widget
(`docs/snippets/price-drop-alert.liquid`, the PR #105 version with client-side email
validation, button loading state, an animated ✓ success panel, and rate-limit/network
error handling) into the `price_drop_alert` custom_liquid block of
`templates/product.json` on the **live** theme `160059195497`. The block previously held
the old single-opt-in confirmation ("You're on the list…" / "C'est noté…"); the
double-opt-in flow needs the visitor to confirm by email, so the success panel now reads:

- EN: **"Check your email to confirm your alert."**
- FR: **"Vérifiez votre courriel pour confirmer votre alerte."**

| Metric | Value |
| --- | --- |
| Asset | `templates/product.json` (theme 160059195497, live) |
| Block touched | `sections.main.blocks.price_drop_alert.settings.custom_liquid` (only) |
| Final custom_liquid length | **9446** (matches the repo snippet exactly) |
| Other blocks / block_order | unchanged |
| `PUT /assets.json` | **200** (verified by re-GET: both confirm strings + success panel present) |

Script: `scripts/update-price-alert-block.mjs` (dry-run by default, `--apply` to PUT).
It targets the block by id (`price_drop_alert`) or content match and rewrites only that
block's `custom_liquid`, preserving every other section/block and `block_order`.

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
