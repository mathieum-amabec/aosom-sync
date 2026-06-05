# Theme mobile/UX overhaul — audit trail (Blocs 1-5)

> All changes were made on the **preview copy theme `160059195497` ("Copie de Trade v2")**.
> The **live theme `141533905001` ("Trade v2") was never touched.**
> The theme lives in Shopify (Admin Assets API + theme translations), not in this repo — this doc is the record.
> Source of the work: `docs/THEME-MOBILE-BACKLOG.md` (Mat's real-iPhone feedback, 4 June). Not published — publish = swap copy to main when validated.
> Preview: `https://27u5y2-kp.myshopify.com/?preview_theme_id=160059195497` (add `/en/` for the English storefront).

## Bloc 1 — header / hero / trust bar / announcement
- **Hero** (`index.json` → `lc_hero`): stronger overlay — desktop `linear-gradient(to right, rgba(0,0,0,.65)→.4 60%→transparent)`, mobile solid `rgba(0,0,0,.7)`. Title on 2 lines on mobile (`<br class="lc-hero-br">`, hidden ≥750px). Mobile title `clamp(1.8rem,6vw,2.5rem)`.
- **Header** (`header.liquid`): mobile media query — logo `max-height 50→55px`, phone `.header__phone` `0.75rem` + reduced margin.
- **Trust bar** (`index.json` → `lc_trustbar`): mobile horizontal swipe (`overflow-x:auto`, scroll-snap, hidden scrollbar, `flex-start`, `0.8rem`). Manual swipe chosen over auto-marquee.
- **Announcement slide 2** (`header-group.json`): review link `/pages/a-propos` → `https://judge.me/reviews/ameublodirect.myshopify.com`.

## Bloc 2 — homepage carousels / collection image
- **Featured collections + category list** (`index.json`): `swipe_on_mobile false→true` on `featured_collection1`, `featured_collection2`, `collection_list` (native Dawn mobile slider). `why_us` + `multicolumn_eWXcry` were already `true`.
- **Patio image** (collection `312997642345` "Mobiliers extérieurs et jardins"): replaced the dated photo with a bright modern Unsplash patio set (`qMfjjGHEtSs`, 1600×1067), alt "Ensemble de mobilier de patio extérieur moderne et lumineux". Unsplash download endpoint triggered (ToS).

## Bloc 3 — featured grid / blog / how-it-works
- **`featured_collection2`**: `products_to_show 5→8` (later repointed in Bloc 4).
- **Blog** (`index.json` → `lc_blog`): mobile 1-card horizontal swipe (`flex:0 0 85vw`, scroll-snap), image ratio `3/2→16/9`, mobile padding `56→36px`. Desktop 3-col grid unchanged. Bilingual title/CTA confirmed (FIX 13).
- **How it works** (`index.json` → `lc_howit`): emojis 1️⃣2️⃣3️⃣ replaced with copper `#C17F3E` 48px numbered circles; desktop dashed connector line, mobile vertical dashed timeline. Icons 🛋️/📦/✨. Bilingual.

## Bloc 4 — product page / featured picks collection
- **Sticky ATC** (`product.json` → `mobile_sticky_atc`): copper `#C17F3E` 64px fixed bar, white price (dynamic) + white "Acheter maintenant"/"Buy now" button → direct checkout (`/cart/add` form with `return_to=/checkout`). Hides when real ATC visible (IntersectionObserver); price + variant id sync on change; body `padding-bottom:80px` only while shown.
- **Product block order** (`product.json`): `title → price → reassurance → variant_picker → quantity → inventory → free_ship_bar → buy_buttons → trust_badges → description → tab_faq(accordion) → share → sticky`.
- **FIX 16 (diagnostic)**: Aosom feed has **no rating/review column** (verified in `csv-fetcher.ts` + live feed header, 35 cols). Reviews rely on **Judge.me** only.
- **Smart collection "Coups de cœur"** (id `473514049641`, handle `coups-de-coeur`): disjunctive tag rules `patio OR chaise-table-patio OR bbq-cuisson OR jardinage-serre OR loveseat OR camping`, sort `best-selling` → 262 products. EN title translation "Featured picks". `featured_collection2` repointed `meubles-et-decorations → coups-de-coeur`, title → "Coups de cœur".

## Bloc 5 — English storefront pass
- **Theme section EN translations** (registered on copy theme `gid://shopify/OnlineStoreTheme/160059195497` via `translationsRegister`):
  - `featured_collection1.title` → "Popular outdoor furniture" (was stale "Spring Seasonal Discount").
  - `featured_collection2.title` → "Featured picks" (was stale "Explore our new arrivals").
  - `product main.tab_faq.heading` → "Shipping, assembly & returns" (was missing).
  - `product main.tab_faq.content` → EN FAQ (was missing).
  - `product main.share.share_label` → "Share" (was stale "Partager").
  - 3 testimonial column titles (names) registered to clear FR fallback.
- **Audited all `index.json`/`product.json`/`header-group.json` strings**: every `custom_liquid` is bilingual via `request.locale.iso_code`; native settings (`why_us`, `multicolumn`, `newsletter`, `collection_list`, `related-products`, announcement) already had correct EN. Theme section translations are stored against the theme — targeting the copy theme gid directly works even while unpublished.
- **FIX 20**: product **description** kept open (not collapsed) — recommended to keep SEO-important content visible. Only "Shipping, assembly & returns" is an accordion.

## Known follow-ups
- Featured-collection section **heading** translation works now via theme translations (done). If new sections are added, register their EN the same way.
- "Buy now" adds to cart then redirects to `/checkout` (`return_to`) — reliable cross-theme; confirm flow on device.
- "Coups de cœur" is a store-level smart collection (also reachable at `/collections/coups-de-coeur`); tags/rules adjustable if the mix needs tuning.
- Publish step: swap copy `160059195497` → main once validated on device (FR + EN).
