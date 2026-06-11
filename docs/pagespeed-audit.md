# PageSpeed audit — home (`ameublodirect.ca`)

**Date:** 2026-06-11 · Read-only analysis of the live home HTML (`scripts/pagespeed-audit.mjs`).
**Overall: healthy.** No render-blocking scripts, fonts load correctly, most images lazy.
A few CLS/lazy refinements below.

## Results

| Area | Finding | Status |
|---|---|---|
| Render-blocking JS (`<head>`) | 44 head scripts, **0** render-blocking (all async/defer/module) | ✅ |
| Fonts (DM Sans) | `@font-face` + `<link rel=preload as=font>`; served from `…/cdn/fonts/dm_sans/dmsans_n5…` (Shopify CDN) | ✅ loaded correctly |
| Image lazy-load | 121 `<img>`: **102 lazy**, 1 eager, **18 no `loading` attr** | ⚠️ 18 default-eager |
| Image dimensions (CLS) | **6 images missing `width`/`height`** | ⚠️ CLS risk |
| Head stylesheets | 5 | ✅ ok |
| Scripts total | 68 `<script>` tags, ~45 KB inline JS | ⚠️ moderate |
| HTML payload | ~684 KB (inflated by inline `<style>`/`<script>` in the many custom-liquid sections) | ⚠️ |
| Video / iframes | 0 `<video>`, 0 `<iframe>` on the current live home | ✅ |
| External script hosts | `cloud.umami.is`, `cdn.shopify.com`, `shop.app`, `ameublodirect.ca` — all legitimate | ✅ |

## Recommendations (priority order)

1. **CLS — add `width`/`height` (or `aspect-ratio`) to the 6 images missing them.** Biggest
   real-user win; prevents layout shift as images load.
2. **Lazy-load the below-the-fold images** among the 18 with no `loading` attr — set
   `loading="lazy"`. **Keep the hero/LCP image eager** (do not lazy-load the first above-the-fold
   image; the current 1 eager image is correct).
3. **Trim inline JS/CSS duplication (~45 KB JS, 684 KB HTML).** The custom-liquid home sections
   (`lc_*`, popup, Shop Pay bar, price-alert, mobile sticky ATC) each ship their own inline
   `<style>`+`<script>`. Consolidating shared CSS into the theme stylesheet and deferring the
   non-critical scripts would cut payload and main-thread work. Not urgent; incremental.
4. **New home video section is perf-safe.** `sections/home-video-showcase.liquid` uses
   `preload="none"` + an IntersectionObserver that only sets each `<source>`'s `src` and calls
   `play()` when the card scrolls into view (and pauses off-screen). So the 6 Aosom MP4s are
   **not** downloaded on initial load — they stream only when visible. Capped at 6 for perf.

## Notes

- These are HTML-static heuristics, not a full Lighthouse run. For Core Web Vitals (LCP/CLS/INP)
  numbers, run PageSpeed Insights / Lighthouse on the published URL after promoting the preview.
- The audit is of the **live** (published) theme; the homepage redesign (cat tiles, video
  section, premium why_us, etc.) lives on the preview and will change these numbers slightly
  (more inline CSS, but the video section is lazy).
