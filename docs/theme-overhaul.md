# Theme overhaul — audit trail

> All changes were made on the **preview copy theme `160059195497` ("Copie de Trade v2")**.
> The **live theme `141533905001` ("Trade v2") was never touched.**
> The theme itself lives in Shopify (Admin Assets API), not in this repo — this doc is the record.
> Base theme: Shopify Dawn ("Trade v2" preset). Locales: FR (primary) + EN (Furnish Direct).

## Palette
- Off-white `#FAFAF8` · text `#1A1A2E` · copper CTA `#C17F3E` · warm beige `#E8E0D8` · gold (logo/sofa) `#C9A84C`
- Fonts kept: DM Sans (headings) + Jost (body)
- `spacing_sections` 0 → 24 (subtle breathing room)
- Site-wide hover polish appended to `assets/base.css` (buttons + product cards)

## Header
- `color_scheme` scheme-4 (dark) → **scheme-1 (light #FAFAF8)**; nav/icons/lang auto-adapt to `#1A1A2E`
- **Bilingual logo** (header.liquid, both logo blocks, unconditional): FR `logo-fr.png` (Ameublo Direct) / EN `logo-en.png` (Furnish Direct) — white bg stripped via sharp, transparent PNG, `max-height:50px`. Favicon sofa extracted to `favicon-32/180.png`, linked in `layout/theme.liquid <head>`.
- Phone `514-292-7788` (tel link, `#1A1A2E`)
- Announcement bar (2 slides, auto-rotate, bilingual via translationsRegister): (1) shipping/returns/payment, (2) "⭐ clients satisfaits → /pages/a-propos"

## Homepage (`templates/index.json`)
Order: hero → trust bar → story1 (meubles) → best-sellers → category list → mobilier ext → free-ship banner → story2 (extérieur) → "Pourquoi nous" → Judge.me → testimonials → blog → "Comment ça marche" → newsletter → trust banner.
- Lifestyle hero (custom_liquid, `lc-hero.jpg`), thin trust bar, 2 storytelling sections (Unsplash + gradient), "Pourquoi nous choisir" (4 cols, native multicolumn, bilingual), bilingual blog teaser (`actualites` FR / `blog` EN), "Comment ça marche" (3 steps), Dawn newsletter section.
- Category list: 6 collections, 3 col desktop / 2 mobile, square images (Unsplash), all 6 imaged.

## Product page (`templates/product.json`)
- Rebuilt to B2C: variant_picker + quantity + buy_buttons (was quick-order-list B2B, removed).
- Free-shipping bar above ATC, 2×2 trust-badge cards, price reassurance, low-stock inventory block.
- Single "Livraison, montage & retours" accordion. Mobile sticky ATC (custom_liquid, dynamic price, clicks real ATC).
- **Bilingual product titles**: `card-product.liquid` + `main-product.liquid` use `custom.title_en` on EN locale (100% metafield coverage).

## Collections (`templates/collection.json`)
- `columns_desktop` 4, `columns_mobile` 2, `products_per_page` 24, filtering + sorting on.

## 404 (`templates/404.json`)
- Custom bilingual page: warm message + 3 copper CTAs (home / furniture / outdoor) + sofa icon, `#FAFAF8`.

## i18n
- custom_liquid sections → bilingual Liquid (`request.locale.iso_code`); native sections (newsletter, multicolumn, announcement, pages) → `translationsRegister`. Pages "À propos" + "FAQ" rewritten FR + EN.

## Repo artifacts (this commit)
- `scripts/vectorize-logos.ts` (potrace experiment — superseded by transparent-PNG approach)
- `Logo/` source webps + generated `logo-fr/en.png`, favicons
- `package.json`/`package-lock.json`: dev deps `sharp`, `potrace`

## Follow-ups before/after publish
- Judge.me: 0 reviews so far → "verified reviews" / "thousands of customers" messaging is aspirational until reviews accrue. Configure post-purchase review-request emails in app.judge.me.
- Logo text renders via `<img>` (no DM Sans webfont in img sandbox — uses image pixels, fine since PNG).
- Publish: swap copy `160059195497` to main when validated.
