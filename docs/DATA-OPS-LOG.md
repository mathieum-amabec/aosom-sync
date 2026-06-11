# Data Operations Log

Audit trail for manual/destructive operations against production data stores
(Turso DB + Shopify). Each entry records the date, the exact rules, and the exact counts.

## 2026-06-11 — Phase 3: Aosom video ingest BATCH (top-30, real upload to Shopify)

`scripts/aosom-video-ingest-batch.mjs --apply`. Attached Aosom product MP4s to the **live
Shopify products** as VIDEO media, via the product-media path (`stagedUploadsCreate(VIDEO)` →
POST bytes to the staged GCS target → `productCreateMedia` → poll `status` to `READY`), covered
by `write_products`. Source = `products.video` for the 30 top-seller SKUs (docs/audit-pdp-video.md
§6); 17 carry a video URL. Throttled to ≤2 Shopify req/s. Idempotent: a SKU logged `READY`, or
whose Shopify product already has a `READY` video, is skipped.

- **Candidates:** 17 SKUs with a `products.video` URL → **14 unique Shopify products** (3 pairs of
  color-variant SKUs share one product: `845-774V00BK`/`SR` → `7793456087145`;
  `84A-054V05BK`/`BN` → `7793456250985`; `84B-136`/`84B-136BK` → `7798393700457`). One product
  carries one video — the first SKU per product is ingested, siblings skipped.
- **Result:** **12 ingérés / 5 skippés / 0 erreurs.**
  - 12 newly attached: `823-010V81`, `845-039V01GY`, `845-335`, `845-518GY`, `845-774V00BK`,
    `845-792V00YL`, `84A-054V05BK`, `84B-136`, `84B-146BU`, `84C-226CG`, `84H-209V00CG`, `D51-277V01`.
  - 5 skipped: `01-0893` (already `READY` from the 3-product validation), `823-002V80` (already had
    a `READY` video — see note), `845-774V00SR` / `84A-054V05BN` / `84B-136BK` (sibling variants).
- **`video_ingest_log` (Turso):** pre-existing table from the manual 3-product validation
  (`01-0415`, `01-0893`, `120307-025`), columns `(sku, product_id, media_id, status, video_url,
  created_at)`. The batch matches that schema and additively adds a nullable `error` column.
  Final state: **16 `READY` + 3 `SKIPPED` = 19 rows.** Each `READY` row carries its
  `gid://shopify/Video/...` media id.
- **Note (partial first run):** the initial `--apply` attached `823-002V80`'s video to Shopify
  (`gid://shopify/Video/39506176868457`) but the log write threw — the live table lacked the
  `shopify_product_id` column the first draft assumed. Fixed the script to the real schema; the
  re-run's existing-video check detected the already-attached video and logged it `READY` (no
  duplicate upload). No products were double-attached.
- **QA (post-ingest):** sampled 5 products via Admin API → each has exactly **1 `READY` VIDEO
  media** (sibling-sharing products show VIDEO=1, dedup confirmed). **Caveat:** all 14 ingested
  products are `status: ACTIVE` but `publishedAt: null` (not on the Online Store channel), so
  `/products/<handle>` 302s to home and the videos are **not shopper-visible yet** — they're the
  store's draft-import backlog. The videos are staged + READY and will render once each product
  is published. Not auto-published (business decision, out of scope).

## 2026-06-12 — Enfants mega-menu + PDP color swatches on PREVIEW theme 160213696617 (live untouched)

Preview theme `160213696617` + the **preview-only** `preview-main-menu` (live `main-menu`
NOT touched). `scripts/apply-enfants.mjs` + `apply-swatches.mjs`.

- **Enfants mega (Chantier 1):** "Enfants" was already in `preview-main-menu` + `mega-menu.liquid`
  (children `jouets-pour-enfants` + `meubles-pour-enfants`). The task's `?type=furniture/toys`
  was **not used** — the `enfants` collection's product types are full Google-taxonomy strings
  ("Toys & Games > …"), so `?type=` would match nothing, and the mega resolves card images by
  collection handle so both `?type=enfants` cards would collapse to one image. Instead, kept the
  2 dedicated collections (distinct images) and: uploaded 2 Unsplash assets
  (`cat-enfants-furniture.jpg` ← children bedroom, `cat-enfants-toys.jpg` ← kids playroom; ToS
  pings sent), swapped the 2 Enfants `mega-menu.liquid` case images to those assets, and
  **`menuUpdate`** repointed the **Enfants parent → the unified `enfants` collection** (37
  products) so "Voir tout «Enfants»" lands there (2 children preserved). All PUT/mutation 200.
- **PDP color swatches (Chantier 2):** `sections/main-product.liquid` — appended a scoped
  `<style>`+`<script>` after `{% render 'product-variant-picker' %}` that turns the **"Couleur"/
  "Color"** option's text pills into round color swatches (name→hex map: Blanc/Noir/Gris/Brun/
  Beige/Bleu/Vert/Rouge/… + EN, partial-match fallback), selected swatch gets a **gold `#D4A853`**
  ring (`input:checked + label`). Non-color options keep text buttons; unknown color names stay
  text (graceful). Layered on Dawn's picker (no snippet edit).

QA (`scripts/verify-enfants-swatches.mjs`): **10 ✅ / 0 ❌**. Visual confirm via admin Theme →
Preview before publishing.

## 2026-06-11 — Phase 6: voice + PDP cross-sell on PREVIEW theme (live untouched)

Target **`160213696617`** (UNPUBLISHED); live **`160059195497` NOT touched** (scripts guarded).

- **C1 voice** (`apply-phase6-voice.mjs`): `templates/index.json` + `sections/header-group.json`
  PUT 200 — featured_sale subtitle, why_us 4 warmer titles, shop_pay tweaks, announcement bar.
- **C2 cross-sell** (`apply-phase6-crosssell.mjs`): `templates/product.json` PUT 200 — existing
  `related-products` section re-titled "Vous aimerez aussi", products_to_show 5→4, cols 5→4.
- **C3 final audit** (`verify-final-audit.mjs`, read-only): **18 ✅ / 0 ❌** →
  `docs/final-theme-audit.md`. Verdict **PRÊT À PUBLIER** (2 non-blocking follow-ups: FR swatch
  config, EN parity on 2 native settings). Final liquid-render confirm via admin Theme → Preview.

## 2026-06-11 — C3 applied: strip leading marketing heading from 26 product descriptions

Production write (Mat-authorized). Backfilled the 26 active products whose `body_html`
opened with a marketing `<h2>/<h3>` (the perceived "duplicate title" under the PDP H1).

- **`scripts/apply-strip-h2.mts`** → `productUpdate(descriptionHtml)` on **26/26 OK** (2 req/s,
  idempotent; re-run reports 0 to fix). The strip removes only the FIRST leading heading and
  keeps the rest (`<p>…`). Several removed headings also carried the brand
  (Aosom/Outsunny/Qaba) — now gone from the description opener.
- **On-push guard:** `src/lib/html-utils.ts` `stripLeadingHeading()` is now applied in
  `shopify-client.ts` (`body_html`), so future imports won't reintroduce it. Unit-tested
  (`tests/html-utils.test.ts`, 8 cases). `tsc` clean, 773 tests green.

## 2026-06-11 — Phase 5: home video showcase section on PREVIEW theme 160213696617 (live untouched)

All writes on the unpublished preview; live `160059195497` not touched
(`scripts/apply-home-video.mjs` preview-guarded). 2 assets PUT (200 each).

- **Candidate query (Turso, read-only):** products with a non-empty `video` (Aosom MP4 URL)
  AND a `shopify_product_id` AND a `shopify_handle` — 20 shown. The 6 chosen for the section
  were filtered to **`status=active` + `published_at` set** (so `all_products[handle]` resolves
  and the card link works): gazebo `84C-546V00CG`, patio steel `84G-683V00BK`, patio rattan
  `860-394V00BG`, dining chairs `83A-212V02BK`, pet stroller `D00-210V00CG`, file cabinet
  `924-077V80GY` (varied: outdoor / furniture / pet / office).
- **`sections/home-video-showcase.liquid`** (new): "Voyez-le chez vous" / "See it at home" +
  subtitle, a responsive grid (3 desktop / 2 tablet / 1 mobile) of **6** video cards on a
  `#FAFAF8` background with navy DM Sans Bold titles. Each card: `<video muted loop playsinline
  preload="none">`, **lazy-loaded via IntersectionObserver** (the MP4 `src` is set and `play()`
  called only when the card scrolls into view; paused off-screen — no MP4 downloaded on initial
  load), poster + title + price pulled live via `all_products[handle]`, navy hover overlay,
  whole card links to the product. The Aosom video URLs are hardcoded (they live in Turso, not
  on the Shopify product).
- **`templates/index.json`**: added `home_video` (type `home-video-showcase`) right **after the
  carousels** (`featured_collection2`).

QA (`scripts/verify-home-video.mjs`): **10 ✅ / 0 ❌**. PageSpeed audit (read-only, live):
`docs/pagespeed-audit.md` — healthy (0 render-blocking JS, DM Sans loaded, 102/121 imgs lazy);
refinements: width/height on 6 imgs (CLS), lazy on 18 more, trim inline JS/CSS.

## 2026-06-11 — 3 data dry-runs: collection matches, EN-title parity, P0 audit (no writes)

All read-only against live Shopify (Admin GraphQL). **No Shopify writes.** Full report:
`docs/data-chantiers-dry-run.md`.

- **C1 collection matches** (`collections-match-dry-run.mjs`): 4 proposed rules vs 502
  products → Électronique 18, Décoration 25, Jardin 195, Enfants 37. No collection created.
- **C2 EN-title parity** (`en-titles-parity-dry-run.mjs`): the 7 A1 products still have the
  brand in EN (6 Translations API, 1 `custom.title_en` metafield); 7/7 would clean. No writes.
- **C3 P0 audit** (`p0-remediation-audit.mjs`): 26/502 active `body_html` open with an
  `<h2>/<h3>` marketing heading (data fix, not CSS); `##` 0/502; 5 drafts — the "2 H1" is the
  draft→home redirect, not a PDP bug. No security P0/P1 outstanding.

All apply steps await Mat's validation.

## 2026-06-11 — Uniform mega-menu (catalog-fit) + hero buttons on PREVIEW (live untouched)

Target **`160213696617`** (UNPUBLISHED); live **`160059195497` NOT touched**.

**Collection audit (read-only, `_collections-audit.mjs`):** 25 collections total. The proposed
8-category × 4-subcat menu is **not catalog-supported**: Mobilier extérieur (8 cols) ✓,
Meubles (6) ✓, Animaux 3, Enfants 2, Jardin 1 dedicated, Déco 0 dedicated
(`meubles-et-decorations` = Meubles), **Électronique 0 (store sells no electronics)**.

**Decision (Mat — catalog-fit):** mega-menus for Mobilier extérieur (4) / Meubles (4) /
Animaux (3: Chiens, Chats, Accessoires) / Enfants (2: Jouets, Meubles enfants); Rabais 🔥 /
Jardin (`jardinage-et-serres`) / Coups de cœur / Catalogue as direct links; **Électronique +
Déco dropped**.

**Writes (preview only):** GraphQL `menuUpdate` on the separate `preview-main-menu` (live
`main-menu` untouched, still used by the live theme); `snippets/mega-menu.liquid` (13 Unsplash
image cards, navy overlay/DM Sans Bold/hover scale; ToS download pinged), `header-mega-menu.liquid`
(delegation), `sections/header-group.json` (repoint), `templates/index.json` (`lc_hero` button
visibility fix: navy-solid + gold-border primary, semi-transparent-white + navy secondary,
title/subtitle text-shadow, bottom gradient overlay). All PUT 200.

**Verify** (`verify-menu-uniform-preview.mjs`): **23 ✅ / 0 ❌**. Animaux (3) / Enfants (2)
megas are sub-4 by catalog reality; Animaux/Enfants parent links reuse a child collection (no
broader "all" collection exists). **Awaiting Mat's visual checkpoint.**

## 2026-06-11 — Phase 4: PDP redesign on PREVIEW theme 160213696617 (live untouched)

All writes on the unpublished preview; live `160059195497` not touched
(`scripts/apply-pdp-redesign.mjs` preview-guarded). 3 assets PUT (200 each):

- **`sections/main-product.liquid`** (title block + buy_buttons case): **eyebrow**
  `<p class="product-eyebrow">{{ product.type }}</p>` above the `<h1>` (DM Sans, uppercase,
  letter-spaced, navy `#1B2A4A`); **Judge.me stars under the H1** via the metafield-badge
  placement `<div class="jdgm-widget jdgm-preview-badge" data-id="{{ product.id }}">{{
  product.metafields.judgeme.badge }}</div>` (no `judgeme_widgets` snippet in the theme; the
  full review widget stays in its existing `apps` section below); **ATC navy** scoped `<style>`
  → `.product-form__submit` `#1B2A4A`/white/radius 4px, hover `#2a3f6b`, full-width mobile.
- **`snippets/price.liquid`**: "Économisez {{ savings }}" (FR) / "Save …" (EN) shown **only when
  discount ≥ 10 %** (`disc_pct = (compare_at − price) × 100 / compare_at`); green, under the price.
- **`templates/product.json`** `trust_badges` block: under-ATC reassurance grid converted from
  emoji (🚚🔄🔒⭐) to **navy thin-line SVG** — Livraison gratuite · Retours 30 jours · Paiement
  sécurisé · Service québécois (4th replaces the old "Judge.me reviews" badge; stars now under H1).

Gallery: no change (Dawn renders `product.media` in order, `media[0]` featured; import already
promotes the lifestyle shot). QA (`scripts/verify-pdp-redesign.mjs`): **8 ✅ / 0 ❌**. Visual
confirm via admin Theme → Preview before publishing.

## 2026-06-11 — Homepage polish final on PREVIEW theme 160213696617 (live untouched)

All writes on the unpublished preview; live `160059195497` not touched
(`scripts/apply-polish-final.mjs` preview-guarded). Read-only audit first:
`docs/preview-final-audit.md`. Single `templates/index.json` PUT (then a popup-form patch PUT).

- **why_us premium (Chantier 3):** rebuilt to 4 distinct points with navy thin-line SVG icons
  on a `#FAFAF8` background — "Catalogue de 490+ produits" (grid), "Livraison gratuite au
  Canada" (truck — the single reassurance shipping mention), "Retours faciles 30 jours" (return
  arrow), "Service client québécois" (leaf).
- **`lc_trustbar`:** dropped the "Livraison gratuite" span (kept Retours · Paiement · Service).
  Home "livraison gratuite" = **2** (announcement bar + why_us).
- **Removed `rich_text`** (the all-caps "PAIEMENT SÉCURISÉ | RETOUR FACILE | SERVICE RAPIDE"
  strip) — fixed the only CAPS marketing + a redundant reassurance bar.
- **`featured_sale`:** removed the 🔥 from the heading → "Meilleures offres du moment".
- **Entry popup (Chantier 2):** new `entry_popup` custom-liquid section — discreet 10%-off email
  capture, navy/gold DM Sans, FR/EN, opens after **5 s OR 50 % scroll** (once per visitor via
  `localStorage` `lc_pop_seen_v1`), close ×/overlay/Esc, mobile-friendly. Email submits via a
  **plain HTML `<form method=post action=/contact>` with `form_type=customer`** (newsletter →
  Shopify customer → Klaviyo sync) — NOT `/api/price-alert` (a price-drop system needing a
  sku/price). Liquid-safe (no `{% form %}` tag).

QA (`scripts/verify-polish-final.mjs`): **8 ✅ / 0 ❌**. **Follow-up:** the 10% code itself is
delivered by Klaviyo's Welcome flow — ensure that flow has a Shopify discount code attached.

## 2026-06-11 — Navigation + hero premium on PREVIEW theme (live untouched)

Target theme **`160213696617`** (UNPUBLISHED); live **`160059195497` NOT touched**. Scripts
hard-abort against the live id.

- **Navigation menu — store-wide caveat:** the navigation menu (`main-menu`) is **store-level
  data, not theme-scoped** — editing it would change the live storefront. So a **new menu
  `preview-main-menu`** was created via GraphQL `menuCreate` (gid recorded by the script) and
  **only the preview theme's `header-group.json`** repointed to it (`menu`:
  `main-menu` → `preview-main-menu`). Live `main-menu` is unchanged and still used by the live
  theme. New structure: Rabais 🔥 / Mobilier extérieur (4 children) / Meubles (4 children) /
  Jardin / Animaux / Déco / Catalogue, all linking existing collections (COLLECTION/CATALOG
  menu items).
- **Theme assets PUT (preview):** `snippets/mega-menu.liquid` (new — image mega cards, 8
  Unsplash photos, navy/gold DM Sans), `snippets/header-mega-menu.liquid` (delegates mega
  panel to the snippet), `sections/header-group.json` (menu repoint), `templates/index.json`
  (`lc_hero` refonte: new headline/subtitle, 2 CTAs, floating badge; existing image kept).
- **Verification:** `verify-nav-hero-preview.mjs` → **17 ✅ / 0 ❌**.
- **Open:** no dedicated "Déco" collection — currently points to `meubles-et-decorations`
  (overlaps Meubles); Mat to curate a real one if wanted. Unsplash ToS download endpoint was
  pinged for the 8 images. **Awaiting Mat's visual checkpoint** before any live promotion.

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
