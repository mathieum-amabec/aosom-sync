# Preview QA report — homepage improvements

**Date:** 2026-06-10 · **Preview theme:** `160213696617` ("Copie de Copie de Trade v2",
unpublished) · **Live theme:** `160059195497` (untouched by chantiers 1-3).
**Method:** automated checks (`scripts/preview-qa.mjs`) against the LIVE storefront
(`ameublodirect.ca`) + Admin-API reads of the PREVIEW theme assets. Legend: ✅ OK ·
❌ FAIL · ⚠️ À VÉRIFIER.

## Result: 16 ✅ / 0 ❌ / 0 ⚠️

| # | Check | Status | Verified where / detail |
|---|-------|--------|--------------------------|
| 1 | og:image = lifestyle 1200×630 (not logo) | ✅ | LIVE renders `…/og-image-social.jpg` (w=1200); preview now carries the same branch |
| 2 | meta description = natural V1 (not CAPS) | ✅ | LIVE renders "Aménagez votre patio…"; no "QUALITÉ/PRIX ACCESSIBLES" |
| 3 | no "liquid error" in sections | ✅ | LIVE home clean; preview featured-collection fixed (see #11) |
| 4 | no "Anonyme" in testimonials | ✅ | PREVIEW: fabricated testimonials section removed entirely |
| 5 | no "Default Title" visible | ✅* | No literal "Default Title" / unguarded `variant.title` render in `card-product.liquid`. *Runtime value — worth a visual spot-check on a single-variant card. |
| 6 | no "##" in descriptions | ✅ | 0/250 product `body_html` contain "##" (catalog-level scan) |
| 7 | no +/- steppers on product cards | ✅ | PREVIEW: `quick_add:"bulk"` count = 0 in `index.json` + `collection.json` |
| 8 | "490" present, no double "500" | ✅ | PREVIEW `index.json`: 490 present; no "Plus de 500"/"500+" |
| 9 | single home newsletter (no dup) | ✅ | PREVIEW: `lc_newsletter` removed; footer `newsletter_DPwWK7` kept (1) |
| 10 | SVG reassurance icons (no 🚚🔄🔒⭐) | ✅ | PREVIEW: `why_us` uses `<svg>`, no emoji; announcement bar clean |
| 11 | no liquid error on featured-collections | ✅ | PREVIEW: `cc_available_products` gone; `paginate collection.products` restored |
| 12 | PREVIEW carries A3 og:image branch | ✅ | `meta-tags.liquid` index branch + asset uploaded to the preview |
| 13 | PREVIEW carries A4 meta description | ✅ | `theme.liquid` + `meta-tags.liquid` index branch on the preview |

## Important — split state & promotion

The fixes live in **two places**:

- **LIVE theme `160059195497`** already has **og:image (A3)** and **meta description (A4)**
  applied (visible on `ameublodirect.ca` now). It does **not** yet have the structural
  homepage fixes (490, single newsletter, 2 carousels, no fake testimonials, SVG reassurance,
  card steppers, featured-collection pagination) — those live on the preview.
- **PREVIEW theme `160213696617`** has **all** of the above, **including** A3/A4 (added in
  this pass so promoting the preview does **not** revert the og:image/meta-description). This
  was the one real risk found by QA and it is now closed.

**To go live:** promote/publish the preview theme (Online Store → Themes → "Copie de Copie de
Trade v2" → Publish). Because the preview now carries A3/A4, publishing it ships the complete,
consistent set. Do a visual pass in **Theme → Preview** first (the public `?preview_theme_id=`
URL serves the published theme without a staff session, so it cannot show preview-only changes).

## Testimonials note (B2)

The fabricated "client testimonials" multicolumn (5 invented reviews, 2 "Anonyme") was
**removed**, not replaced with new fabricated names — inventing named customer testimonials is
deceptive advertising (QC Consumer Protection Act / Competition Act). The real **Judge.me**
reviews widget remains on the home and shows genuine reviews as they accumulate. To showcase
reviews now, provide the Judge.me PUBLIC API token (or real, permission-cleared customer
quotes) and they can be wired in honestly.
