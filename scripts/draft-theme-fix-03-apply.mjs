// Apply the 3 draft-theme fixes (P1 hero anchor target, P2 rabais filter banner,
// P3 remove branded PawHut video). Draft theme 160606093417 ONLY.
// Dry-run by default; pass --apply to PUT. Re-asserts the theme is unpublished before any write.
import { rest } from "./_shopify-lib.mjs";

const DRAFT = "160606093417";
const LIVE = "160584859753";
const APPLY = process.argv.includes("--apply");

// ---- Safety gate: never write unless DRAFT is unpublished and LIVE is main ----
const themes = (await (await rest("/themes.json")).json()).themes;
const draftT = themes.find((t) => String(t.id) === DRAFT);
const liveT = themes.find((t) => String(t.id) === LIVE);
if (!draftT || draftT.role === "main") throw new Error(`REFUSE: draft ${DRAFT} role=${draftT?.role} (must not be main)`);
if (!liveT || liveT.role !== "main") throw new Error(`REFUSE: live ${LIVE} role=${liveT?.role} (must be main)`);
console.log(`Gate OK — draft "${draftT.name}" [${draftT.role}], live "${liveT.name}" [${liveT.role}]`);
console.log(APPLY ? "\n*** APPLY MODE — will PUT to draft ***\n" : "\n--- DRY RUN (no writes) ---\n");

async function getAsset(key) {
  const res = await rest(`/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`getAsset ${key}: ${res.status}`);
  return (await res.json()).asset.value;
}
async function putAsset(key, value) {
  const res = await rest(`/themes/${DRAFT}/assets.json`, {
    method: "PUT",
    body: JSON.stringify({ asset: { key, value } }),
  });
  if (!res.ok) throw new Error(`putAsset ${key}: ${res.status} ${await res.text()}`);
  return res.json();
}
function assert(cond, msg) { if (!cond) throw new Error("ASSERT FAIL: " + msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Shopify asset reads are eventually-consistent right after a PUT — retry the check.
async function verifyRetry(key, test, msg, tries = 6) {
  for (let i = 0; i < tries; i++) {
    if (test(await getAsset(key))) return;
    await sleep(2500);
  }
  throw new Error("ASSERT FAIL (after retries): " + msg);
}

// ============ P1 — give cat_tiles an id="categories" so the hero #categories CTA scrolls there ============
{
  const key = "templates/index.json";
  const raw = await getAsset(key);
  const json = JSON.parse(raw);
  const cat = json.sections?.cat_tiles;
  assert(cat && cat.settings && typeof cat.settings.custom_liquid === "string", "cat_tiles.custom_liquid present");
  let cl = cat.settings.custom_liquid;
  // Hero CTA sanity: confirm it already points at #categories (no change needed there).
  const hero = json.sections?.lc_hero?.settings?.custom_liquid || "";
  assert(hero.includes('href="#categories"'), "hero CTA already targets #categories");
  const anchorOld = '<div class="page-width lc-cat lc-reveal">';
  const anchorNew = '<div id="categories" class="page-width lc-cat lc-reveal" style="scroll-margin-top:100px">';
  if (cl.includes('id="categories"')) {
    console.log("P1: already has id=categories — skip");
  } else {
    assert(cl.includes(anchorOld), "cat_tiles wrapper div found");
    cl = cl.replace(anchorOld, anchorNew);
    cat.settings.custom_liquid = cl;
    const out = JSON.stringify(json, null, 2);
    console.log(`P1: index.json ${raw.length} -> ${out.length} bytes; cat_tiles now anchors #categories`);
    if (APPLY) {
      await putAsset(key, out);
      await verifyRetry(key, (s) => JSON.parse(s).sections.cat_tiles.settings.custom_liquid.includes('id="categories"'), "P1 id present after PUT");
      console.log("P1: PUT verified ✓");
    }
  }
}

// ============ P3 — remove the branded PawHut 'poussette' video block ============
{
  const key = "sections/home-video-showcase.liquid";
  const v = await getAsset(key);
  const re = /\n[ \t]*\{%-\s*assign p = all_products\['poussette-pliable-pour-grands-chiens-avec-4-roues-et-amortisseurs'\]\s*-%\}[\s\S]*?\{%-\s*endif\s*-%\}/;
  if (!/poussette-pliable-pour-grands-chiens/.test(v)) {
    console.log("P3: poussette block already gone — skip");
  } else {
    const m = v.match(re);
    assert(m, "P3 poussette block matched");
    assert(/PawHut/.test(m[0]), "P3 matched block contains PawHut (right one)");
    const out = v.replace(re, "");
    assert(!/PawHut/.test(out), "P3 PawHut removed");
    assert(!/poussette-pliable-pour-grands-chiens/.test(out), "P3 poussette handle removed");
    // other 3 products survive
    for (const h of ["gazebo-3x3m-toit-rigide-polycarbonate-avec-rideaux-gris-fonce",
      "ensemble-de-patio-en-acier-5-pieces-avec-table-en-verre-trempe",
      "ensemble-de-patio-4-pieces-en-rotin-avec-causeuse-et-table-beige"]) {
      assert(out.includes(h), "P3 kept " + h);
    }
    console.log(`P3: home-video-showcase ${v.length} -> ${out.length} bytes; PawHut/poussette block removed, 3 videos remain`);
    if (APPLY) {
      await putAsset(key, out);
      await verifyRetry(key, (s) => !/PawHut/.test(s), "P3 no PawHut after PUT");
      console.log("P3: PUT verified ✓");
    }
  }
}

// ============ P2 — rabais quick-cat-banner ============
const RABAIS_BLOCK = `{% comment %} Bandeau catégories rapides — affiché uniquement sur /collections/rabais {% endcomment %}
{% if collection.handle == 'rabais' %}
<div class="quick-cat-banner">
  <div class="quick-cat-inner">
    <span class="quick-cat-label">Filtrer par :</span>
    <div class="quick-cat-links">
      <a href="/collections/meubles-deco?sort_by=price-ascending" class="quick-cat-pill">🛋️ Meubles</a>
      <a href="/collections/exterieur-et-jardin?sort_by=price-ascending" class="quick-cat-pill">🌿 Extérieur</a>
      <a href="/collections/electro-et-tech?sort_by=price-ascending" class="quick-cat-pill">⚡ Électro &amp; Tech</a>
      <a href="/collections/animaux?sort_by=price-ascending" class="quick-cat-pill">🐾 Animaux</a>
      <a href="/collections/enfants?sort_by=price-ascending" class="quick-cat-pill">🧒 Enfants</a>
      <a href="/collections/sport-et-loisirs?sort_by=price-ascending" class="quick-cat-pill">🏀 Sports &amp; Loisirs</a>
      <a href="/collections/rabais" class="quick-cat-pill quick-cat-pill--promo" aria-current="page">🔥 Rabais</a>
    </div>
  </div>
</div>

<style>
.quick-cat-banner {
  background: #f8f6f2;
  border-bottom: 1px solid #e8e4dc;
  padding: 0.75rem 1rem;
  position: sticky;
  top: 0;
  z-index: 10;
}
.quick-cat-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.quick-cat-label {
  font-family: 'DM Sans', sans-serif;
  font-size: 0.8rem;
  font-weight: 600;
  color: #1B2A4A;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.quick-cat-links {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.quick-cat-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.35rem 0.75rem;
  border-radius: 999px;
  border: 1.5px solid #1B2A4A;
  background: #fff;
  color: #1B2A4A;
  font-family: 'DM Sans', sans-serif;
  font-size: 0.82rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.quick-cat-pill:hover {
  background: #1B2A4A;
  color: #fff;
}
.quick-cat-pill--promo {
  border-color: #D4A853;
  color: #D4A853;
}
.quick-cat-pill--promo:hover {
  background: #D4A853;
  color: #fff;
}
@media (max-width: 767px) {
  .quick-cat-inner { flex-direction: column; align-items: flex-start; }
  .quick-cat-links { flex-wrap: nowrap; }
}
</style>
{% endif %}

`;
{
  const key = "sections/main-collection-product-grid.liquid";
  const v = await getAsset(key);
  if (v.includes("collection.handle == 'rabais'")) {
    console.log("P2: rabais banner already present — skip");
  } else {
    assert(v.includes("collection.handle == 'all'"), "existing 'all' banner present (template baseline)");
    const out = RABAIS_BLOCK + v;
    console.log(`P2: main-collection-product-grid ${v.length} -> ${out.length} bytes; rabais banner prepended`);
    if (APPLY) {
      await putAsset(key, out);
      await verifyRetry(key, (s) => s.includes("collection.handle == 'rabais'"), "P2 rabais block after PUT");
      console.log("P2: PUT verified ✓");
    }
  }
}

// ---- prove LIVE untouched ----
const liveIdx = await rest(`/themes/${LIVE}/assets.json?asset[key]=${encodeURIComponent("templates/index.json")}`);
if (liveIdx.ok) console.log(`\nLIVE templates/index.json updated_at: ${(await liveIdx.json()).asset.updated_at}`);
console.log(APPLY ? "\nDONE (applied)." : "\nDONE (dry run). Re-run with --apply to write.");
