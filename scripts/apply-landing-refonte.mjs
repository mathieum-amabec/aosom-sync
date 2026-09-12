/**
 * apply-landing-refonte — push the landing-page refonte to the DEDICATED working
 * theme copy, and nowhere else.
 *
 * What it does, all on ONE theme id passed as --theme:
 *   1. Uploads the five new/rewritten snippets from shopify-theme/snippets/.
 *   2. Rewrites templates/index.json: new section order, the trust bar replacing
 *      the "pourquoi nos prix sont bas" panel, the two new trend-driven sections,
 *      "Nouveaux arrivages" removed, the reviews section moved up, the
 *      see-all-inventory CTA added.
 *   3. Converts the main category grid's MOBILE layout from a swipe carousel to
 *      a 2-column CSS grid (tile set and labels untouched).
 *   4. Replaces the stale "759+ produits" statistic everywhere it appears.
 *
 * SAFETY — it refuses to run against the published theme. The guard resolves
 * `role` live from themes.json on every run and aborts if the target is (or has
 * become) `main`. It does NOT trust the constants in _shopify-lib.mjs, which are
 * known-stale, and it never reads or writes any theme but the one requested.
 *
 * USAGE (x64 Node, prod creds):
 *   node-x64 --env-file=.env.local scripts/apply-landing-refonte.mjs --theme <id>
 *   …--theme <id> --apply      # without --apply it prints the plan and exits
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply");
const THEME = (() => {
  const i = process.argv.indexOf("--theme");
  return i > -1 ? process.argv[i + 1] : "";
})();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNIPPET_DIR = path.join(ROOT, "shopify-theme", "snippets");

if (!TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing (use --env-file=.env.local)");
if (!/^\d+$/.test(THEME)) throw new Error("--theme <numeric id> is required");

let lastReq = 0;
async function rest(endpoint, options = {}) {
  const wait = 520 - (Date.now() - lastReq); // ~1.9 req/s, under Shopify's 2/s
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`https://${STORE}/admin/api/${API}${endpoint}`, {
    ...options,
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${endpoint}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** Abort unless `THEME` is an unpublished theme that exists right now. */
async function assertSafeTarget() {
  const { themes } = await rest("/themes.json?fields=id,name,role");
  const live = themes.find((t) => t.role === "main");
  const target = themes.find((t) => String(t.id) === THEME);
  if (!target) throw new Error(`ABORT: theme ${THEME} does not exist`);
  if (target.role === "main" || String(live.id) === THEME) {
    throw new Error(`ABORT: theme ${THEME} is the PUBLISHED theme — refusing to write`);
  }
  console.log(`live (untouched): ${live.id} "${live.name}"`);
  console.log(`target          : ${target.id} [${target.role}] "${target.name}"`);
  return target;
}

const getAsset = async (key) =>
  (await rest(`/themes/${THEME}/assets.json?asset[key]=${encodeURIComponent(key)}`)).asset.value;

const putAsset = async (key, value) =>
  rest(`/themes/${THEME}/assets.json`, {
    method: "PUT",
    body: JSON.stringify({ asset: { key, value } }),
  });

// ── the snippets this refonte owns ───────────────────────────────────────────
const SNIPPETS = [
  "lc_trustbar.liquid",
  "lc_trending_products.liquid",
  "lc_trending_subcats.liquid",
  "lc_cta_inventory.liquid",
  "lc_judgeme_all_reviews.liquid",
];

// ── the stale statistic, and its replacement ─────────────────────────────────
const STAT_REPLACEMENTS = [
  {
    section: "lc_hero",
    from: "{% if loc == 'en' %}759+ products &middot; Secure payment{% else %}Plus de 759 produits &middot; Paiement s&eacute;curis&eacute;{% endif %}",
    to: "{% if loc == 'en' %}Hundreds of products in stock, delivered this week{% else %}Des centaines de produits en stock, livr&eacute;s cette semaine{% endif %}",
  },
  {
    section: "why_us",
    from: "{% if loc == 'en' %}759+ products for every space{% else %}Plus de 759 produits pour tous les espaces{% endif %}",
    to: "{% if loc == 'en' %}Hundreds of products in stock, delivered this week{% else %}Des centaines de produits en stock, livr&eacute;s cette semaine{% endif %}",
  },
  {
    section: "lc_howit",
    from: "{% if loc == 'en' %}Browse our catalog of 759+ products{% else %}Parcourez notre catalogue de 759+ produits{% endif %}",
    to: "{% if loc == 'en' %}Hundreds of products in stock, delivered this week{% else %}Des centaines de produits en stock, livr&eacute;s cette semaine{% endif %}",
  },
];

// ── main category grid: mobile swipe carousel → 2-column CSS grid ────────────
// The tile set, links, images and labels are untouched; only the mobile layout
// changes, so all 8 tiles are reachable without a horizontal gesture.
const CAT_MOBILE_FROM = `@media (max-width: 767px){
  .lc-cat .lc-cat-grid{display:flex;flex-wrap:nowrap;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;grid-auto-rows:initial;}
  .lc-cat .lc-cat-grid::-webkit-scrollbar{display:none;}
  .lc-cat .lc-cat-tile,.lc-cat .lc-cat-tile--lg{flex:0 0 62vw;height:200px;scroll-snap-align:start;border-radius:12px;}
}`;
const CAT_MOBILE_TO = `@media (max-width: 767px){
  /* Fixed grid, not a carousel: every tile visible without a swipe. */
  .lc-cat .lc-cat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;overflow:visible;grid-auto-rows:initial;}
  .lc-cat .lc-cat-tile,.lc-cat .lc-cat-tile--lg{flex:initial;width:auto;height:auto;aspect-ratio:4/3;max-width:100%;border-radius:10px;grid-column:auto;grid-row:auto;}
  /* Half-width tiles have no room for three lines — keep the label, drop the
     kicker and the CTA (both already hidden on desktop). */
  .lc-cat .lc-cat-tile__kicker,.lc-cat .lc-cat-tile__cta{display:none;}
  .lc-cat .lc-cat-tile__label{font-size:.78rem;font-weight:700;color:#fff;padding-bottom:.5rem;}
}`;

/** The page order after the refonte. Sections not listed are dropped. */
const NEW_ORDER = [
  "lc_design_system",     // CSS/JS bootstrap, must stay first
  "lc_hero",              // 1. hero (unchanged)
  "lc_seasonal_band",     // existing banner, stays in place
  "lc_trustbar",          // 2. compact trust bar (replaces lc_valueprop)
  "lc_trending_products", // 3. "Les plus demandés cette semaine"
  "cat_tiles",            // 4. 8 main category tiles (fixed grid)
  "lc_trending_subcats",  // 5. 8 popular subcategory tiles (fixed grid)
  "lc_jm_all_reviews",    // 6. Judge.me reviews (moved up, improved)
  "lc_cta_inventory",     // 7. "Voir tout l'inventaire"
  // ── everything below is unchanged, in its existing relative order ──
  "lc_ugc_reel",
  "featured_sale",
  "lc_story1",
  "lc_story2",
  "why_us",
  "1774571510a047e4d5",
  "lc_blog",
  "lc_howit",
  "lc_trust",
  "lc_loop",
  "entry_popup",
];

/**
 * Sections this refonte creates, each a thin wrapper around its snippet.
 *
 * `padding_top`/`padding_bottom` MUST be 0: Dawn's custom-liquid section schema
 * defaults them to 40px each, and every other custom-liquid section on this page
 * already zeroes them. Leaving them at the default put ~136px of dead grey space
 * under the trust bar — each snippet owns its own vertical rhythm.
 */
const SECTION_PADDING = { padding_top: 0, padding_bottom: 0 };
const NEW_SECTIONS = {
  lc_trustbar: { type: "custom-liquid", settings: { custom_liquid: "{% render 'lc_trustbar' %}", ...SECTION_PADDING } },
  lc_trending_products: { type: "custom-liquid", settings: { custom_liquid: "{% render 'lc_trending_products' %}", ...SECTION_PADDING } },
  lc_trending_subcats: { type: "custom-liquid", settings: { custom_liquid: "{% render 'lc_trending_subcats' %}", ...SECTION_PADDING } },
  lc_cta_inventory: { type: "custom-liquid", settings: { custom_liquid: "{% render 'lc_cta_inventory' %}", ...SECTION_PADDING } },
};

/** Sections removed from the page entirely. */
const DROPPED = ["lc_valueprop", "featured_collection2"];

async function main() {
  await assertSafeTarget();

  const index = JSON.parse(await getAsset("templates/index.json"));
  const before = [...index.order];

  // 1. new sections
  for (const [key, def] of Object.entries(NEW_SECTIONS)) index.sections[key] = def;

  // 2. drop the retired ones
  for (const key of DROPPED) delete index.sections[key];

  // 3. the stale statistic
  // Idempotent: re-running against an already-converted theme is a no-op, not an
  // abort — but a section where NEITHER the old nor the new wording is present
  // still aborts, because that means the theme is not what this script expects.
  const statLog = [];
  for (const { section, from, to } of STAT_REPLACEMENTS) {
    const s = index.sections[section];
    const liquid = s?.settings?.custom_liquid ?? "";
    if (liquid.includes(from)) {
      s.settings.custom_liquid = liquid.split(from).join(to);
      statLog.push(section);
    } else if (liquid.includes(to)) {
      statLog.push(`${section} (already)`);
    } else {
      throw new Error(`ABORT: stat verbatim not found in "${section}"`);
    }
  }

  // 4. main category grid → mobile CSS grid
  const cat = index.sections.cat_tiles?.settings?.custom_liquid ?? "";
  if (cat.includes(CAT_MOBILE_FROM)) {
    index.sections.cat_tiles.settings.custom_liquid = cat.replace(CAT_MOBILE_FROM, CAT_MOBILE_TO);
  } else if (!cat.includes(CAT_MOBILE_TO)) {
    throw new Error("ABORT: cat_tiles mobile CSS block not found");
  }

  // 5. order — every listed section must exist, and nothing may be orphaned
  for (const key of NEW_ORDER) {
    if (!index.sections[key]) throw new Error(`ABORT: ordered section "${key}" has no definition`);
  }
  index.order = NEW_ORDER;
  for (const key of Object.keys(index.sections)) {
    if (!NEW_ORDER.includes(key)) delete index.sections[key];
  }

  console.log(`\nsnippets   : ${SNIPPETS.join(", ")}`);
  console.log(`stat fixed : ${statLog.join(", ")}`);
  console.log(`dropped    : ${DROPPED.join(", ")}`);
  console.log(`order before (${before.length}): ${before.join(" → ")}`);
  console.log(`order after  (${index.order.length}): ${index.order.join(" → ")}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  for (const file of SNIPPETS) {
    const value = fs.readFileSync(path.join(SNIPPET_DIR, file), "utf8");
    await putAsset(`snippets/${file}`, value);
    console.log(`  wrote snippets/${file} (${value.length} bytes)`);
  }
  await putAsset("templates/index.json", JSON.stringify(index, null, 2));
  console.log(`  wrote templates/index.json`);
  console.log(`\nDONE on theme ${THEME} (unpublished).`);
}

await main();
