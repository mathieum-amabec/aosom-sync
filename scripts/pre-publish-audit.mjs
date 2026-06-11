// Read-only pre-publish audit: preview 160213696617 vs live 160059195497.
import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617", LIVE = "160059195497";
const get = (k, th) => getAsset(k, th).catch(() => null);

// ===== AUDIT 1 — preview vs live diffs =====
console.log("===== AUDIT 1 — preview vs live =====");
const pIdx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
const lIdx = JSON.parse(await getAsset("templates/index.json", LIVE));
const pSet = new Set(pIdx.order), lSet = new Set(lIdx.order);
console.log("index.json sections only in PREVIEW:", pIdx.order.filter((s) => !lSet.has(s)).join(", ") || "(none)");
console.log("index.json sections only in LIVE   :", lIdx.order.filter((s) => !pSet.has(s)).join(", ") || "(none)");
console.log(`index.json section count: preview=${pIdx.order.length} live=${lIdx.order.length}`);

for (const f of ["sections/header-group.json", "layout/theme.liquid", "snippets/meta-tags.liquid"]) {
  const p = await get(f, PREVIEW), l = await get(f, LIVE);
  console.log(`\n--- ${f} ---`);
  if (!p || !l) { console.log("  (missing on one theme)"); continue; }
  console.log(`  identical: ${p === l}  | len preview=${p.length} live=${l.length}`);
  if (f.endsWith("header-group.json")) {
    const pm = (p.match(/"menu":"([^"]+)"/g) || []).join(",");
    const lm = (l.match(/"menu":"([^"]+)"/g) || []).join(",");
    console.log(`  preview menu refs: ${pm}`);
    console.log(`  live    menu refs: ${lm}`);
  }
  if (f.endsWith("meta-tags.liquid")) {
    console.log(`  preview og-image-social branch: ${p.includes("og-image-social.jpg")} | live: ${l.includes("og-image-social.jpg")}`);
  }
}

// ===== AUDIT 2 — SEO on LIVE storefront =====
console.log("\n===== AUDIT 2 — SEO (live storefront) =====");
const html = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`, { cache: "no-store" })).text();
const head = html.slice(0, html.indexOf("</head>") + 7);
const g = (re) => { const m = head.match(re); return m ? m[1] : "(none)"; };
console.log("og:image  :", g(/property=["']og:image["'][^>]*content=["']([^"']+)/i).slice(0, 75));
console.log("meta desc :", g(/name=["']description["'][^>]*content=["']([^"']*)/i).slice(0, 75));
console.log("title     :", (head.match(/<title>([^<]*)<\/title>/i) || [])[1] || "(none)");
console.log("canonical :", g(/rel=["']canonical["'][^>]*href=["']([^"']+)/i));
console.log("JSON-LD blocks:", (html.match(/application\/ld\+json/gi) || []).length);
console.log("schema.org refs:", (html.match(/schema\.org/gi) || []).length);

// ===== AUDIT 3 — content (preview index.json) =====
console.log("\n===== AUDIT 3 — content (preview) =====");
const pj = JSON.stringify(pIdx.sections);
const hg = await getAsset("sections/header-group.json", PREVIEW);
const livIdx = (pj.match(/livraison gratuite/gi) || []).length;
const livHg = (hg.match(/livraison gratuite/gi) || []).length;
console.log(`livraison gratuite: index=${livIdx} + announcement=${livHg} = ${livIdx + livHg} (target <=2)`);
console.log("'Anonyme':", (pj.match(/anonyme/gi) || []).length);
console.log("'Default Title':", (pj.match(/Default Title/g) || []).length);
console.log("'490' present:", pj.includes("490"), "| 'Plus de 500'/'500+':", /Plus de 500|500\+/.test(pj));
const fg = JSON.parse(await getAsset("sections/footer-group.json", PREVIEW));
const fgNews = Object.values(fg.sections).filter((s) => s.type === "newsletter").length;
const idxNews = !!pIdx.sections.lc_newsletter;
console.log(`newsletter blocks: footer=${fgNews}, home lc_newsletter=${idxNews ? "present" : "absent"}`);
console.log("entry_popup present:", !!pIdx.sections.entry_popup && pIdx.order.includes("entry_popup"));
console.log("cat_tiles present:", !!pIdx.sections.cat_tiles);
const mega = await get("snippets/mega-menu.liquid", PREVIEW);
console.log("mega-menu.liquid present:", !!mega);
const w = pIdx.sections.why_us?.settings?.custom_liquid || "";
console.log("why_us premium (4 svg, #FAFAF8):", (w.match(/<svg/g) || []).length, "svg,", w.includes("#FAFAF8") ? "FAFAF8 bg" : "no bg");
// product '##'
const prods = (await (await rest("/products.json?limit=250&fields=body_html")).json()).products || [];
console.log("'##' in product descriptions:", prods.filter((p) => /##/.test(p.body_html || "")).length, "/", prods.length);

// ===== AUDIT 4 — performance =====
console.log("\n===== AUDIT 4 — performance =====");
console.log("home section count:", pIdx.order.length);
const reassur = pIdx.order.filter((id) => /trustbar|why_us|rich_text/.test(id));
console.log("reassurance-type sections:", reassur.join(", "));
const stories = pIdx.order.filter((id) => /lc_story/.test(id));
console.log("story sections:", stories.join(", "));
console.log("--- uploaded image assets present? ---");
for (const a of ["assets/og-image-social.jpg", "assets/cat-tile-1.jpg", "assets/cat-tile-2.jpg", "assets/cat-tile-3.jpg", "assets/cat-tile-4.jpg", "assets/cat-tile-5.jpg", "assets/cat-tile-6.jpg"]) {
  console.log(`  ${a}: ${(await get(a, PREVIEW)) !== null ? "present" : "MISSING"}`);
}

// ===== AUDIT 5 — theme security (preview layout/theme.liquid) =====
console.log("\n===== AUDIT 5 — theme security (preview theme.liquid) =====");
const th = await getAsset("layout/theme.liquid", PREVIEW);
console.log("Umami tracking:", /umami|cloud\.umami|data-website-id/i.test(th));
console.log("Meta Pixel:", /fbq\(|connect\.facebook\.net|facebook.*pixel|fbevents/i.test(th));
console.log("og:image in head (via meta-tags render):", th.includes("render 'meta-tags'") || th.includes("og:image"));
console.log("meta description tag:", /name="description"/.test(th));
// suspicious external scripts (non-allowlisted hosts)
const scriptSrcs = [...th.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
const allow = /shopify|umami|facebook|google|cdn\.|judge\.me|klaviyo|ameublodirect|^\/|\{\{/i;
const susp = scriptSrcs.filter((s) => !allow.test(s));
console.log("external <script src> count:", scriptSrcs.length, "| non-allowlisted:", susp.length ? susp.join(", ") : "none");
