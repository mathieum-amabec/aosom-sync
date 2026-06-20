// LIVE 160059195497 (authorized): (1) delete orphan global metafields,
// (2) apply the homepage meta description via theme — same index-branch approach as
// og:image. Patches BOTH the <meta name="description"> in layout/theme.liquid (the SEO
// one Google reads) AND og_description in snippets/meta-tags.liquid (og/twitter), so the
// home description is consistent everywhere. Backups + verify. Non-index pages unchanged.
import { writeFileSync } from "node:fs";
import { rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const LIVE = LIVE_THEME_ID;
const META = "Aménagez votre patio et votre jardin pour l'été québécois : mobilier d'extérieur, BBQ, déco et accessoires, livrés gratuitement partout au Canada.";

// 1. Delete orphan shop metafields (global.description_tag, global.og_image).
const mfs = (await (await rest("/metafields.json?namespace=global")).json()).metafields || [];
for (const mf of mfs) {
  if (mf.key === "description_tag" || mf.key === "og_image") {
    const d = await rest(`/metafields/${mf.id}.json`, { method: "DELETE" });
    console.log(`DELETE metafield global.${mf.key} (id ${mf.id}): ${d.status}`);
  }
}
const after = (await (await rest("/metafields.json?namespace=global")).json()).metafields || [];
console.log("remaining global shop metafields:", after.map((m) => m.key).join(", ") || "(none)");

// 2a. theme.liquid — <meta name="description"> index branch
let layout = await getAsset("layout/theme.liquid", LIVE);
writeFileSync(".git/live-theme-liquid-backup2-2026-06-10.liquid", layout, "utf8");
const L_OLD = `{% if page_description %}
      <meta name="description" content="{{ page_description | escape }}">
    {% endif %}`;
const L_NEW = `{% if request.page_type == 'index' %}
      <meta name="description" content="${META}">
    {% elsif page_description %}
      <meta name="description" content="{{ page_description | escape }}">
    {% endif %}`;
if (layout.includes(`content="${META}"`)) {
  console.log("theme.liquid description already patched — skipping");
} else if (!layout.includes(L_OLD)) {
  throw new Error("ABORT: description block not found verbatim in theme.liquid");
} else {
  await putAsset("layout/theme.liquid", layout.replace(L_OLD, L_NEW), LIVE);
  console.log("theme.liquid PUT 200 (description index branch added)");
}

// 2b. meta-tags.liquid — og_description index override (drives og:/twitter:description)
let snip = await getAsset("snippets/meta-tags.liquid", LIVE);
writeFileSync(".git/live-meta-tags-backup2-2026-06-10.liquid", snip, "utf8");
const S_OLD = `  assign og_description = page_description | default: shop.description | default: shop.name`;
const S_NEW = `${S_OLD}
  if request.page_type == 'index'
    assign og_description = "${META}"
  endif`;
if (snip.includes(`assign og_description = "${META}"`)) {
  console.log("meta-tags og_description already patched — skipping");
} else if (!snip.includes(S_OLD)) {
  throw new Error("ABORT: og_description assign not found verbatim in meta-tags.liquid");
} else {
  await putAsset("snippets/meta-tags.liquid", snip.replace(S_OLD, S_NEW), LIVE);
  console.log("meta-tags.liquid PUT 200 (og_description index override added)");
}

// 3. Verify (fresh renders; home cache may lag a few minutes)
await new Promise((r) => setTimeout(r, 4000));
for (let i = 0; i < 3; i++) {
  const r = await fetch(`https://ameublodirect.ca/?cb=${Date.now()}${i}`, { cache: "no-store" });
  const h = await r.text();
  const head = h.slice(0, h.indexOf("</head>") + 7);
  const desc = (head.match(/name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || "(none)";
  const ogd = (head.match(/property=["']og:description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || "(none)";
  console.log(`home cb${i}: bytes ${h.length}\n   description=${desc.slice(0, 70)}\n   og:description=${ogd.slice(0, 70)}`);
  await new Promise((r) => setTimeout(r, 1500));
}
