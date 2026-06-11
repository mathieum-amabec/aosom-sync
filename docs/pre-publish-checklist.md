# Pre-publish checklist — preview `160213696617`

**Date:** 2026-06-11 · **Preview:** `160213696617` · **Live:** `160059195497` (published).
Read-only audit (`scripts/pre-publish-audit.mjs` + `pre-publish-followup.mjs`). No writes.

**Verdict: READY to publish** with 2 items to confirm manually (⚠️) and 1 note.

## AUDIT 1 — preview vs live diffs

| File | Diff |
|---|---|
| `templates/index.json` | ✅ Preview **15** sections vs live **18**. Preview **removed** the old `collection_list`, `featured_collection1`, `rich_text`, `multicolumn_eWXcry` (fake testimonials), `lc_newsletter` (dup) and **added** `cat_tiles` + `entry_popup`. Intended improvements. |
| `sections/header-group.json` | ✅ Preview uses menu **`preview-main-menu`** + an **emoji-free** announcement bar; live uses `main-menu` + "🚚 … 🔄 …". Preview is the cleaned version. |
| `layout/theme.liquid` | ✅ **Identical** to live. |
| `snippets/meta-tags.liquid` | ✅ **Identical**; both carry the `og-image-social` index branch. |

## AUDIT 2 — SEO (live storefront) — all ✅

| Check | Result |
|---|---|
| og:image lifestyle (not logo) | ✅ `…/cdn/shop/t/6/assets/og-image-social.jpg` |
| meta description natural (not CAPS) | ✅ "Aménagez votre patio et votre jardin…" |
| title tag | ✅ "Ameublo Direct \| Meubles et mobiliers extérieurs" |
| structured data (schema.org) | ✅ 2 JSON-LD blocks |
| canonical URL | ✅ `https://ameublodirect.ca/` |

## AUDIT 3 — content (preview index.json)

| Check | Result |
|---|---|
| Max 2 "livraison gratuite" | ✅ 2 (announcement bar + `why_us`) |
| 0 "Anonyme" | ✅ 0 |
| 0 "Default Title" | ✅ 0 |
| 0 "##" in descriptions | ✅ 0 / 250 product `body_html` |
| "490" (no double "500") | ✅ 490 present, no "Plus de 500"/"500+" |
| 1 newsletter block | ✅ footer 1, home `lc_newsletter` absent |
| Entry popup present | ✅ `entry_popup` in sections + order |
| Category tiles (`cat_tiles`) | ✅ present |
| Mega-menu (`mega-menu.liquid`) | ✅ present |
| `why_us` premium (4 SVG icons) | ✅ 4 `<svg>`, `#FAFAF8` bg |
| 0 liquid error | ⚠️ **Verify via admin Theme → Preview.** All known constructs are sound (featured-collection pagination fixed; popup is a plain HTML form, no `{% form %}`), but the authenticated preview render can't be fetched here (`?preview_theme_id=` serves the published theme). |

## AUDIT 4 — performance

- **15** home sections.
- Reassurance now appears in **2** places (`lc_trustbar` thin bar + `why_us` grid) — the redundant `rich_text` strip was removed. No critical redundancy.
- ℹ️ Two story blocks (`lc_story1`, `lc_story2`) — distinct content, kept; trim if desired.
- ✅ **All uploaded images present** on the preview: `og-image-social.jpg`, `cat-tile-1..6.jpg` (7/7).

## AUDIT 5 — theme security (preview `layout/theme.liquid`)

| Check | Result |
|---|---|
| No suspicious scripts | ✅ 11 `<script src>`, **0 non-allowlisted** (all Shopify/Umami/CDN/app hosts) |
| Meta tags correct (og:image, description) | ✅ rendered via `meta-tags` snippet + description tag present |
| Umami tracking | ✅ present in theme + rendered HTML |
| Meta Pixel | ⚠️ **Not found** in `theme.liquid` nor the rendered live HTML (`fbq`/`fbevents` absent). It may be installed as a **sandboxed Web Pixel** via the Facebook & Instagram app (invisible in page HTML). **Verify in Settings → Customer events**; if absent, install it before relying on Meta ad tracking. |

## Notes before publishing

1. **Nav source = `preview-main-menu`** (a store-level menu created for the preview). Publishing
   the theme makes the live store use it. Confirm its structure is correct; per the prior nav
   work, "Déco" currently points to `meubles-et-decorations` (no dedicated Déco collection yet).
2. **Popup 10% code** — the popup captures emails into Shopify→Klaviyo; the actual **10% code is
   sent by the Klaviyo Welcome flow**. Attach a Shopify discount code to that flow before launch.
3. **Promotion** — publish via Online Store → Themes → "Copie de Copie de Trade v2" → Publish.
   The preview already carries A3/A4 SEO, so publishing won't revert og:image / meta description.

## Summary

✅ 26 · ⚠️ 3 (liquid-error visual confirm · Meta Pixel · nav/popup notes) · ❌ 0.
The preview is **publish-ready** pending the 2 manual confirmations above.
