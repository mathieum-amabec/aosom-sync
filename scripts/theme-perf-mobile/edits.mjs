// Perf mobile 2026-11-04 — edits applied as exact string replacements on the FRESH asset content,
// so concurrent edits by others to the same file are preserved (an anchor that no longer matches = hard stop).
const SWATCH_BLOCK_START = "{%- comment -%} Card colour dots — styles + hover swap (idempotent per page). {%- endcomment -%}";

export const EDITS = {
  "layout/theme.liquid": [
    // Klaviyo: the app embed (config/settings_data.json, klaviyo-onsite-embed) already injects
    // klaviyo.js?company_id=XAvTkS. This second copy downloaded and ran the SDK twice.
    // The queue stub + the "Viewed Product" push below stay: klaviyo.js drains _klOnsite on load.
    [
      `    <script async src="https://static.klaviyo.com/onsite/js/XAvTkS/klaviyo.js"></script>\n`,
      `    {%- comment -%} 2026-11-04 perf: klaviyo.js is loaded ONCE by the Klaviyo app embed (klaviyo.js?company_id=XAvTkS). The second copy that lived here was removed; the stub above keeps queuing pushes until it loads. {%- endcomment -%}\n`,
    ],
    // Wheel of fortune fully off, assistant widget removed (fab hidden since 2026-10-24, ~0 messages since).
    [
      `      {% render 'lc-roue' %}\n      {% render 'lc-warranty-guard' %}\n      {% render 'lc-assistant-widget' %}\n`,
      `      {%- comment -%} 2026-11-04 perf mobile: 'lc-roue' (welcome wheel, auto-opening, covered "Filtrer et trier") and 'lc-assistant-widget' (fab hidden since 2026-10-24, ~1 message/week) are no longer rendered. Both snippets stay in the theme; re-add the render line to restore. {%- endcomment -%}\n      {% render 'lc-warranty-guard' %}\n      {% render 'lc-card-swatch-js' %}\n`,
    ],
  ],
  "sections/main-product.liquid": [
    [
      `        {%- if product.featured_image -%}{% render 'lc-visualiser', product: product %}{%- endif -%}\n`,
      `        {%- comment -%} 2026-11-04 perf mobile: 'lc-visualiser' ("Voyez-le chez vous — BIENTÔT" teaser) removed from the product page until the feature is live. {%- endcomment -%}\n`,
    ],
  ],
  "snippets/lc-pdp-qa.liquid": [
    // the assistant is no longer on the page, so its "ask" button would be dead
    [
      /\n      <p><button type="button" class="lc-qa__ask" data-lc-qa-ask>[^\n]*<\/button><\/p>/,
      "",
    ],
    [`<div class="lc-vis-slot" data-lc-vis-slot></div>\n`, ""],
  ],
  "snippets/product-thumbnail.liquid": [
    [
      `  unless lazy_load == false\n    assign lazy = 'lazy'\n  endunless\n`,
      `  unless lazy_load == false\n    assign lazy = 'lazy'\n  endunless\n  # 2026-11-04 perf: the first gallery image is the mobile LCP — fetch it eagerly at high priority.\n  assign lc_fp = 'auto'\n  if lazy_load == false and position == 1\n    assign lazy = 'eager'\n    assign lc_fp = 'high'\n  endif\n`,
    ],
    [
      `          class: image_class,\n          loading: lazy,\n          sizes: sizes,`,
      `          class: image_class,\n          loading: lazy,\n          fetchpriority: lc_fp,\n          sizes: sizes,`,
    ],
  ],
  "snippets/card-product.liquid": [
    // the swatch <style>+<script> was printed once PER CARD (24× on a collection page)
    [new RegExp(escapeRe(SWATCH_BLOCK_START) + "\\s*<style>[\\s\\S]*?</style>\\s*<script>[\\s\\S]*?</script>\\s*$"), "{%- comment -%} 2026-11-04 perf: the colour-dot styles + hover swap now live in snippets/lc-card-swatch-js.liquid, rendered once from layout/theme.liquid. {%- endcomment -%}\n"],
  ],
  "snippets/judgeme_core.liquid": [
    [
      `{%- if template contains 'product' -%}\n<link rel="stylesheet" href="https://cdn.judge.me/shopify_v2.css" media="all">`,
      `{%- if template contains 'product' -%}\n{%- assign lc_rev_count = product.metafields.reviews.rating_count.value | default: 0 | plus: 0 -%}\n{%- if lc_rev_count == 0 -%}\n{%- comment -%} 2026-11-04: no review yet (3,474 of 3,484 products) → no empty "Avis clients / Soyez le premier" block, no "No reviews" string, no widget fetch. Count = Judge.me's reviews.rating_count metafield. {%- endcomment -%}\n<style>.jdgm-preview-badge,.jdgm-widget,#judgeme_product_reviews,[id^="shopify-section-"][id$="__17745733386da0d1df"]{display:none!important}</style>\n{%- else -%}\n<link rel="stylesheet" href="https://cdn.judge.me/shopify_v2.css" media="all">`,
    ],
    [`  if (document.readyState !== "loading") { run(); } else { document.addEventListener("DOMContentLoaded", run); }\n})();\n</script>\n{%- endif -%}`,
     `  if (document.readyState !== "loading") { run(); } else { document.addEventListener("DOMContentLoaded", run); }\n})();\n</script>\n{%- endif -%}\n{%- endif -%}`],
  ],
  "snippets/lc_ugc_video_reel.liquid": [
    // root:track made a video "visible" as soon as the reel existed, even far below the fold:
    // the homepage downloaded a 3 MB mp4 on load. Start the autoplay observer only once the
    // reel is near the viewport.
    [
      `      cards.forEach(function(c){io.observe(c.querySelector('.lcugc-vid'));});\n`,
      `      var lcNear=new IntersectionObserver(function(es){if(!es[0].isIntersecting)return;lcNear.disconnect();cards.forEach(function(c){io.observe(c.querySelector('.lcugc-vid'));});},{rootMargin:'200px 0px'});\n      lcNear.observe(track);\n`,
    ],
  ],
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export const NEW_FILES = ["snippets/lc-card-swatch-js.liquid"];
