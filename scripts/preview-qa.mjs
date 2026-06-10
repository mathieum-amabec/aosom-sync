// CHANTIER 3 — automated QA across LIVE storefront + PREVIEW theme assets.
import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";
const out = [];
const rec = (status, point, detail) => { out.push({ status, point, detail }); console.log(`${status}  ${point} — ${detail}`); };

// ---- LIVE storefront (og:image + meta description + liquid error live) ----
const live = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
const lh = live.slice(0, live.indexOf("</head>") + 7);
const og = (lh.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "";
const ogw = (lh.match(/og:image:width["'][^>]*content=["']([^"']+)/i) || [])[1] || "?";
rec(og.includes("og-image-social") ? "✅" : (og.includes("Logo") ? "❌" : "⚠️"), "og:image lifestyle (LIVE)", `${og.slice(0, 70)} (w=${ogw})`);
const desc = (lh.match(/name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1] || "";
rec(desc.includes("Aménagez votre patio") ? "✅" : (/QUALIT|PRIX ACCESS/.test(desc) ? "❌" : "⚠️"), "meta description V1 (LIVE)", desc.slice(0, 70));
rec(/liquid error/i.test(live) ? "❌" : "✅", "no liquid error (LIVE home)", /liquid error/i.test(live) ? "FOUND" : "none");

// ---- PREVIEW assets ----
const idxRaw = await getAsset("templates/index.json", PREVIEW);
const idx = JSON.parse(idxRaw);
rec(/anonyme/i.test(idxRaw) ? "❌" : "✅", "no 'Anonyme' testimonials (PREVIEW)", /anonyme/i.test(idxRaw) ? "still present" : "removed");
rec(idxRaw.includes("490") && !/Plus de 500|500\+/.test(idxRaw) ? "✅" : "⚠️", "'490' present, no '500' (PREVIEW)", `490=${idxRaw.includes("490")}, 500=${/Plus de 500|500\+/.test(idxRaw)}`);
const fc = Object.values(idx.sections).filter((s) => s.type === "featured-collection").length;
rec(fc === 2 ? "✅" : "⚠️", "2 carousels (PREVIEW)", `featured-collection sections = ${fc}`);
rec(idx.sections.lc_newsletter ? "❌" : "✅", "no duplicate home newsletter (PREVIEW)", idx.sections.lc_newsletter ? "lc_newsletter present" : "lc_newsletter removed");
const fg = JSON.parse(await getAsset("sections/footer-group.json", PREVIEW));
const fgNews = Object.values(fg.sections).filter((s) => s.type === "newsletter").length;
rec(fgNews === 1 ? "✅" : "⚠️", "footer newsletter kept (PREVIEW)", `footer newsletter sections = ${fgNews}`);

// quick_add (no +/- steppers)
const coll = JSON.parse(await getAsset("templates/collection.json", PREVIEW));
const bulkIdx = JSON.stringify(idx).match(/"quick_add"\s*:\s*"bulk"/g) || [];
const bulkColl = JSON.stringify(coll).match(/"quick_add"\s*:\s*"bulk"/g) || [];
rec(bulkIdx.length === 0 && bulkColl.length === 0 ? "✅" : "❌", "no +/- on product cards (PREVIEW)", `quick_add:bulk index=${bulkIdx.length} collection=${bulkColl.length}`);

// SVG reassurance, no emojis
const whyus = idx.sections.why_us?.settings?.custom_liquid || "";
const emojiRe = /🚚|🔄|🔒|⭐/;
rec(whyus.includes("<svg") && !emojiRe.test(whyus) ? "✅" : "⚠️", "SVG reassurance icons, no emoji (why_us)", `svg=${whyus.includes("<svg")}, emoji=${emojiRe.test(whyus)}`);
const hg = await getAsset("sections/header-group.json", PREVIEW);
rec(!emojiRe.test(hg) ? "✅" : "❌", "no emoji in announcement bar (header-group)", emojiRe.test(hg) ? "emoji present" : "clean");

// featured-collection pagination
const fcl = await getAsset("sections/featured-collection.liquid", PREVIEW);
rec(!fcl.includes("cc_available_products") && fcl.includes("paginate section.settings.collection.products by") ? "✅" : "❌", "featured-collection pagination ok (PREVIEW)", `cc_available_products=${fcl.includes("cc_available_products")}`);

// "##" in product descriptions (catalog-level; sample 250)
const prods = (await (await rest("/products.json?limit=250&fields=body_html")).json()).products || [];
const hashCount = prods.filter((p) => /##/.test(p.body_html || "")).length;
rec(hashCount === 0 ? "✅" : "⚠️", "no literal '##' in descriptions (sample 250)", `${hashCount}/250 with ##`);

// "Default Title" visible on cards — scan card-product.liquid
let card = "";
try { card = await getAsset("snippets/card-product.liquid", PREVIEW); } catch {}
const dtLiteral = /Default Title/.test(card) || /Default Title/.test(idxRaw);
rec(dtLiteral ? "⚠️" : "✅", "no 'Default Title' literal in card source", dtLiteral ? "found literal" : "none (A2: no visible variant.title render)");

// ---- Promotion gotcha: does the PREVIEW carry the A3/A4 (og/meta) edits? ----
const pmeta = await getAsset("snippets/meta-tags.liquid", PREVIEW);
const ptheme = await getAsset("layout/theme.liquid", PREVIEW);
const previewHasOg = pmeta.includes("og-image-social.jpg") && pmeta.includes("request.page_type == 'index'");
const previewHasMeta = ptheme.includes("Aménagez votre patio") || pmeta.includes("Aménagez votre patio");
rec(previewHasOg ? "✅" : "⚠️", "PREVIEW carries A3 og:image branch", previewHasOg ? "yes" : "NO — og/meta live-only; promoting preview would revert A3/A4");
rec(previewHasMeta ? "✅" : "⚠️", "PREVIEW carries A4 meta-desc", previewHasMeta ? "yes" : "NO — applied to LIVE theme only");

console.log("\n=== SUMMARY ===");
const pass = out.filter((o) => o.status === "✅").length, fail = out.filter((o) => o.status === "❌").length, warn = out.filter((o) => o.status === "⚠️").length;
console.log(`✅ ${pass} | ❌ ${fail} | ⚠️ ${warn}`);
