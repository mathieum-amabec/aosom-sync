// Make the PREVIEW theme promotion-safe by carrying the same A3/A4 SEO edits that
// live as on the live theme (otherwise promoting the preview reverts og:image + meta
// description). PREVIEW-only guard. Mirrors apply-og-live-v2 + apply-meta-desc-live.
import { rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";
const LIVE = LIVE_THEME_ID;
const PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT: preview equals live");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error("ABORT: not an unpublished preview");
console.log(`Target preview: ${t.id} "${t.name}" [${t.role}]`);

const META = "Aménagez votre patio et votre jardin pour l'été québécois : mobilier d'extérieur, BBQ, déco et accessoires, livrés gratuitement partout au Canada.";

// asset present?
try { await getAsset("assets/og-image-social.jpg", PREVIEW); console.log("og asset: present"); }
catch { throw new Error("ABORT: assets/og-image-social.jpg missing on preview"); }

// 1. Remove the OLD duplicate og injection from preview layout/theme.liquid (before </head>).
let layout = await getAsset("layout/theme.liquid", PREVIEW);
const OLD_INJECT = `  <meta property="og:image" content="{{ 'og-image-social.jpg' | asset_url }}">\n</head>`;
if (layout.includes(OLD_INJECT)) {
  layout = layout.replace(OLD_INJECT, "</head>");
  console.log("step1: removed old duplicate og injection before </head>");
} else console.log("step1: no old og injection to remove (already clean)");

// 2. theme.liquid description -> index branch
const L_OLD = `{% if page_description %}
      <meta name="description" content="{{ page_description | escape }}">
    {% endif %}`;
const L_NEW = `{% if request.page_type == 'index' %}
      <meta name="description" content="${META}">
    {% elsif page_description %}
      <meta name="description" content="{{ page_description | escape }}">
    {% endif %}`;
if (layout.includes(`content="${META}"`)) console.log("step2: description already patched");
else if (!layout.includes(L_OLD)) throw new Error("ABORT: description block not found in preview theme.liquid");
else { layout = layout.replace(L_OLD, L_NEW); console.log("step2: description index branch added"); }
await putAsset("layout/theme.liquid", layout, PREVIEW);
console.log("theme.liquid PUT 200");

// 3. meta-tags.liquid: og:image index branch + og_description index override
let snip = await getAsset("snippets/meta-tags.liquid", PREVIEW);
const OG_OLD = `{%- if page_image -%}
  <meta property="og:image" content="http:{{ page_image | image_url }}">
  <meta property="og:image:secure_url" content="https:{{ page_image | image_url }}">
  <meta property="og:image:width" content="{{ page_image.width }}">
  <meta property="og:image:height" content="{{ page_image.height }}">
{%- endif -%}`;
const OG_NEW = `{%- if request.page_type == 'index' -%}
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
if (snip.includes("og-image-social.jpg")) console.log("step3a: og:image branch already present");
else if (!snip.includes(OG_OLD)) throw new Error("ABORT: og:image block not found in preview meta-tags.liquid");
else { snip = snip.replace(OG_OLD, OG_NEW); console.log("step3a: og:image index branch added"); }

const D_OLD = `  assign og_description = page_description | default: shop.description | default: shop.name`;
const D_NEW = `${D_OLD}
  if request.page_type == 'index'
    assign og_description = "${META}"
  endif`;
if (snip.includes(`assign og_description = "${META}"`)) console.log("step3b: og_description already patched");
else if (!snip.includes(D_OLD)) throw new Error("ABORT: og_description assign not found in preview meta-tags.liquid");
else { snip = snip.replace(D_OLD, D_NEW); console.log("step3b: og_description index override added"); }
await putAsset("snippets/meta-tags.liquid", snip, PREVIEW);
console.log("meta-tags.liquid PUT 200");

// verify
const v1 = await getAsset("snippets/meta-tags.liquid", PREVIEW);
const v2 = await getAsset("layout/theme.liquid", PREVIEW);
console.log("\nverify: meta-tags og branch =", v1.includes("og-image-social.jpg"), "| og_desc =", v1.includes(`assign og_description = "${META}"`));
console.log("verify: theme.liquid desc branch =", v2.includes(`content="${META}"`), "| old og injection gone =", !v2.includes(OLD_INJECT));
