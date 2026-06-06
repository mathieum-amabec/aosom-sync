// Integrate Plausible Analytics into the preview copy theme 160059195497.
//  - ÉTAPE 2: cookieless Plausible script in <head> (auto pageviews, multi-domain)
//  - ÉTAPE 3: custom click goals — Hero CTA, Sticky ATC, Messenger, Add to Cart
// Uses script.tagged-events.js (strict superset of script.js: same auto pageviews,
// plus class-based click goals) + a window.plausible() queue stub for the JS-driven
// add-to-cart event. Idempotent: re-running is a no-op. Backs up each asset first.
import { getAsset, putAsset, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });

function backup(name, value) {
  writeFileSync(join(reportsDir, `${name}.plausible-backup.txt`), value, "utf8");
}

// Plausible <head> snippet. Multi-domain so both storefront domains report to Plausible.
const PLAUSIBLE_HEAD = `<!-- Plausible Analytics (cookieless, conforme RGPD/PIPEDA — aucune bannière de cookies requise) -->
    <script defer data-domain="ameublodirect.ca,furnishdirect.ca" src="https://plausible.io/js/script.tagged-events.js"></script>
    <script>
      window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
      // Add to Cart (main product form). Capture phase so it fires before product-form.js preventDefault.
      // The sticky bar (#mobile-sticky-atc) is excluded — it reports its own "Sticky ATC" goal.
      document.addEventListener('submit', function (e) {
        var f = e.target;
        if (f && f.matches && f.matches('form[action*="/cart/add"]') && !f.closest('#mobile-sticky-atc')) {
          window.plausible('Add to Cart');
        }
      }, true);
    </script>`;

const results = [];

// ===== ÉTAPE 2 + Messenger goal — layout/theme.liquid =====
{
  const key = "layout/theme.liquid";
  let v = await getAsset(key);
  backup("theme.liquid", v);
  let changed = false;

  if (!v.includes("plausible.io")) {
    const anchor = "{% render 'meta-tags' %}";
    if (!v.includes(anchor)) throw new Error("theme.liquid: meta-tags anchor not found");
    v = v.replace(anchor, `${anchor}\n\n    ${PLAUSIBLE_HEAD}`);
    changed = true;
    console.log("✓ theme.liquid: Plausible <head> script injected after meta-tags");
  } else {
    console.log("• theme.liquid: Plausible already present, skipped head injection");
  }

  // Messenger floating button goal
  if (!v.includes("plausible-event-name=Messenger")) {
    const before = v;
    v = v.replace('class="lc-msgr"', 'class="lc-msgr plausible-event-name=Messenger+Click"');
    if (v !== before) { changed = true; console.log("✓ theme.liquid: Messenger goal tagged on .lc-msgr"); }
    else console.log("× theme.liquid: .lc-msgr class not matched");
  } else console.log("• theme.liquid: Messenger goal already tagged");

  if (changed && !DRY) { await putAsset(key, v); console.log("  → theme.liquid written"); }
  results.push([key, changed]);
}

// ===== ÉTAPE 3 — Hero CTA goal in templates/index.json (lc_hero) =====
{
  const key = "templates/index.json";
  const raw = await getAsset(key);
  backup("index.json", raw);
  const idx = JSON.parse(raw);
  const hero = idx.sections.lc_hero.settings.custom_liquid;
  let changed = false;
  if (!hero.includes("plausible-event-name=Hero")) {
    const fixed = hero.replace('class="lc-btn"', 'class="lc-btn plausible-event-name=Hero+CTA"');
    if (fixed !== hero) {
      idx.sections.lc_hero.settings.custom_liquid = fixed;
      changed = true;
      console.log("✓ index.json: Hero CTA goal tagged on .lc-btn");
    } else console.log("× index.json: .lc-btn class not matched");
  } else console.log("• index.json: Hero CTA goal already tagged");

  if (changed && !DRY) { await putAsset(key, JSON.stringify(idx, null, 2)); console.log("  → index.json written"); }
  results.push([key, changed]);
}

// ===== ÉTAPE 3 — Sticky ATC goal in templates/product.json (#mobile-sticky-atc) =====
{
  const key = "templates/product.json";
  const raw = await getAsset(key);
  backup("product.json", raw);
  let changed = false;
  let out = raw;
  if (!raw.includes("plausible-event-name=Sticky")) {
    // operate on the raw JSON text; the button markup lives in a custom_liquid string
    const needle = '<button type=\\"submit\\">{% if loc == \'en\' %}Buy now';
    const repl = '<button type=\\"submit\\" class=\\"plausible-event-name=Sticky+ATC\\">{% if loc == \'en\' %}Buy now';
    if (raw.includes(needle)) {
      out = raw.replace(needle, repl);
      changed = true;
      console.log("✓ product.json: Sticky ATC goal tagged on submit button");
    } else {
      console.log("× product.json: sticky ATC button needle not matched");
    }
  } else console.log("• product.json: Sticky ATC goal already tagged");

  if (changed && !DRY) {
    JSON.parse(out); // validate it's still valid JSON before writing
    await putAsset(key, out);
    console.log("  → product.json written");
  }
  results.push([key, changed]);
}

console.log(`\n[${DRY ? "DRY" : "DONE"}] theme ${PREVIEW_THEME_ID}`);
console.log(results.map(([k, c]) => `  ${c ? "changed" : "no-op "} ${k}`).join("\n"));
