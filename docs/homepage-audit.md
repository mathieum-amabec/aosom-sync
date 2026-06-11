# Homepage audit — premium redesign (read-only)

**Date:** 2026-06-11 · **Preview theme:** `160213696617` ("Copie de Copie de Trade v2",
unpublished) · **Live `160059195497` not touched.** Source: `scripts/homepage-audit.mjs`
(Admin-API reads). No writes.

## 1. Home sections + order (15)

| # | Section id | Type | Heading / source |
|---|-----------|------|------------------|
| 1 | `lc_hero` | custom-liquid | hero H1 (mentions "Livraison gratuite") |
| 2 | `lc_trustbar` | custom-liquid | ✓ reassurance bar (Livraison gratuite · …) |
| 3 | `shop_pay_home` | custom-liquid | Shop Pay 4-col bar |
| 4 | `featured_sale` | featured-collection | "🔥 Meilleures offres du moment" → `rabais` |
| 5 | `lc_story1` | custom-liquid | story block |
| 6 | **`collection_list`** | **collection-list** | **"Magasinez par catégorie" — 6 category tiles** |
| 7 | `featured_collection2` | featured-collection | "Coups de cœur" → `coups-de-coeur` |
| 8 | `rich_text` | rich-text | reassurance banner (caps) |
| 9 | `lc_story2` | custom-liquid | story block |
| 10 | `why_us` | custom-liquid | "Pourquoi nous choisir" SVG icon grid (mentions "Livraison gratuite") |
| 11 | `1774571510a047e4d5` | apps | Judge.me reviews widget + badge |
| 12 | `lc_blog` | custom-liquid | blog teaser |
| 13 | `lc_howit` | custom-liquid | "Comment ça marche" 3 steps |
| 14 | `lc_trust` | custom-liquid | "Satisfaction garantie 30 jours" + tagline |
| 15 | `lc_loop` | custom-liquid | loop/marquee |

## 2. Navigation — `sections/header-group.json`

- `announcement-bar` with 2 rotating messages:
  1. **"Livraison gratuite au Canada | Retours faciles 30 jours | Paiement sécurisé"**
  2. "Nouveau : Laissez-nous votre avis après votre achat !"
- `header` (logo + nav menu).

## 3. "livraison gratuite" occurrences (all preview assets) — 8 total

| Asset / section | Count | Home? | Keep? |
|---|---|---|---|
| `header-group.json` announcement bar | 1 | ✅ home (header) | **KEEP** (announcement bar) |
| `index.json` → `lc_trustbar` | 1 | ✅ home | **KEEP** (reassurance bar) |
| `index.json` → `lc_hero` | 1 | ✅ home | **REPLACE** (alt message) |
| `index.json` → `why_us` | 1 | ✅ home | **REPLACE** (alt message) |
| `templates/cart.json` | 1 | ❌ cart page | leave |
| `templates/product.json` | 3 | ❌ PDP | leave |

**Home currently shows 4** "livraison gratuite" mentions → target **2** (announcement bar +
reassurance bar). Chantier 1 replaces the `lc_hero` and `why_us` mentions with alternatives
("Service client québécois", "Satisfaction garantie 30 jours", "Paiement sécurisé", "Plus de
490 produits").

## 4. Category buttons — `collection_list` ("Magasinez par catégorie")

Native Shopify **collection-list** section: 6 `featured_collection` blocks rendered as square
collection cards (collection `featured_image` + title), 3 columns desktop / 2 mobile,
`color_scheme: scheme-4`. Current style = the theme's default collection card (image + plain
title link) — **not premium**, depends on whatever `featured_image` each collection has.

The 6 categories (by handle):

| # | Collection handle | Premium tile · Unsplash query |
|---|-------------------|-------------------------------|
| 1 | `meubles-et-decorations` | "modern living room furniture" |
| 2 | `mobiliers-exterieurs-et-jardins` | "outdoor patio furniture summer" |
| 3 | `chaises-et-tables-de-patio-1` | "patio dining set outdoor" |
| 4 | `jardinage-et-serres` | "garden backyard landscaping" |
| 5 | `accessoires-pour-animaux` | "pet dog cat home" |
| 6 | `sports-et-loisirs` | "camping outdoor recreation backyard" |

**Chantier 2 plan:** replace the native `collection-list` with a `custom-liquid` premium tile
grid — Unsplash lifestyle background (uploaded as preview theme assets), navy `#1B2A4A` 50%
overlay, white DM Sans Bold title, hover (slight overlay + `scale(1.02)`), responsive 3×2 /
2-col mobile, each tile linking to `/collections/<handle>`. Real collection titles fetched at
apply time.

## Plan summary (chantiers, all PREVIEW-only)

1. **Reduce "livraison gratuite"** home 4 → 2 (keep announcement bar + `lc_trustbar`; replace
   `lc_hero` + `why_us` mentions with alternative reassurance messages).
2. **Premium category tiles** — replace `collection_list` with a custom-liquid grid (Unsplash
   bg + navy overlay + white bold titles + hover).
3. **Automated verification** after each PUT (asset re-read + live fetch + ✅/❌ report).
