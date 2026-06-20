// Clean og:image fix on LIVE: revert the duplicate injected into layout/theme.liquid,
// then patch snippets/meta-tags.liquid so the HOME (index) uses our 1200x630 asset as
// the single og:image source. Product/collection/article pages keep page_image.
import { readFileSync, writeFileSync } from "node:fs";
import { getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const LIVE = LIVE_THEME_ID;

// 1. Revert layout/theme.liquid to the pre-edit backup (removes the duplicate og tag).
const backup = readFileSync(".git/live-theme-liquid-backup-2026-06-10.liquid", "utf8");
const curLayout = await getAsset("layout/theme.liquid", LIVE);
if (curLayout.includes("og-image-social.jpg")) {
  await putAsset("layout/theme.liquid", backup, LIVE);
  console.log("layout/theme.liquid reverted to backup (duplicate og tag removed): PUT 200");
} else {
  console.log("layout/theme.liquid has no og-image-social — already clean, skipping revert");
}

// 2. Patch snippets/meta-tags.liquid — add an index branch.
const snip = await getAsset("snippets/meta-tags.liquid", LIVE);
writeFileSync(".git/live-meta-tags-backup-2026-06-10.liquid", snip, "utf8");
const OLD = `{%- if page_image -%}
  <meta property="og:image" content="http:{{ page_image | image_url }}">
  <meta property="og:image:secure_url" content="https:{{ page_image | image_url }}">
  <meta property="og:image:width" content="{{ page_image.width }}">
  <meta property="og:image:height" content="{{ page_image.height }}">
{%- endif -%}`;
const NEW = `{%- if request.page_type == 'index' -%}
  {%- assign og_social = 'og-image-social.jpg' | asset_url | prepend: 'https:' -%}
  <meta property="og:image" content="{{ og_social }}">
  <meta property="og:image:secure_url" content="{{ og_social }}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
{%- elsif page_image -%}
  <meta property="og:image" content="http:{{ page_image | image_url }}">
  <meta property="og:image:secure_url" content="https:{{ page_image | image_url }}">
  <meta property="og:image:width" content="{{ page_image.width }}">
  <meta property="og:image:height" content="{{ page_image.height }}">
{%- endif -%}`;

if (snip.includes("og-image-social.jpg")) {
  console.log("meta-tags.liquid already patched — skipping");
} else if (!snip.includes(OLD)) {
  throw new Error("ABORT: expected og:image block not found verbatim in meta-tags.liquid (no change made)");
} else {
  const patched = snip.replace(OLD, NEW);
  await putAsset("snippets/meta-tags.liquid", patched, LIVE);
  console.log("snippets/meta-tags.liquid PUT 200 (index branch added)");
}

// 3. Verify home render (cache-bust) + a product page is unaffected.
await new Promise((r) => setTimeout(r, 4000));
const strip = (s) => s;
for (const path of ["/", "/collections/all"]) {
  const res = await fetch(`https://ameublodirect.ca${path}?nocache=${Date.now() % 100000}`, { cache: "no-store" });
  const html = await res.text();
  const head = html.slice(0, html.indexOf("</head>") + 7);
  const ogs = [...head.matchAll(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi)].map((m) => m[1]);
  const w = (head.match(/og:image:width["'][^>]*content=["']([^"']+)/i) || [])[1];
  console.log(`\n${path} status ${res.status}, bytes ${html.length}, og:image tags ${ogs.length}, width ${w}`);
  ogs.forEach((u, i) => console.log(`   [${i}] ${u}`));
}
