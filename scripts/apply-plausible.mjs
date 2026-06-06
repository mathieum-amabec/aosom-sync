// Integrate Plausible Analytics into the preview copy theme 160059195497.
//  - ÉTAPE 2: cookieless Plausible script in <head> (auto pageviews)
//  - ÉTAPE 3: custom click goals — Hero CTA, Sticky ATC, Messenger, Add to Cart
//
// Design notes (after adversarial review):
//  - script.tagged-events.js (strict superset of script.js: same auto pageviews,
//    plus class-based click goals via `plausible-event-name=<Name>`).
//  - Hero CTA + Messenger are <a> links → tagged-events handles those reliably
//    (its core, supported use case).
//  - The Sticky ATC button submits a PLAIN <form> that does a full-page POST →
//    /checkout. A tagged class on a navigating submit button races page-unload and
//    drops the goal, so we handle the sticky in JS: preventDefault, fire the goal
//    with a callback that re-submits (plus a failsafe timeout if Plausible is
//    blocked/slow). NOT tagged in product.json.
//  - "Add to Cart" is scoped to Dawn <product-form> adds (fetch-based, no nav, so
//    no event loss) and excludes the sticky form (handled above) and quick-add.
//  - Single domain by default. furnishdirect.ca can be added later (see docs) once
//    it's a confirmed, separately-created Plausible site — listing an uncreated
//    site silently discards events and double-burns the pageview quota.
//
// Idempotent: re-running replaces the marker-delimited head block in place and is a
// no-op for the tagged classes. Backs up each asset first.
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

const PL_START = "<!-- Plausible Analytics: START (managed by scripts/apply-plausible.mjs) -->";
const PL_END = "<!-- Plausible Analytics: END -->";

// Marker-delimited so re-running can replace the block in place.
const PLAUSIBLE_HEAD = `${PL_START}
    <!-- Cookieless, conforme RGPD/PIPEDA/Loi 25 — aucune bannière de cookies requise. -->
    <script defer data-domain="ameublodirect.ca" src="https://plausible.io/js/script.tagged-events.js"></script>
    <script>
      window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
      document.addEventListener('submit', function (e) {
        var f = e.target;
        if (!f || !f.matches || !f.matches('form[action*="/cart/add"]')) return;
        if (f.closest('#mobile-sticky-atc')) {
          // Sticky bar does a full-page POST → /checkout. Send the goal first, then
          // submit, so the event isn't lost to page-unload. Failsafe submits anyway
          // if Plausible is blocked or hasn't loaded yet. (form.submit() does NOT
          // re-fire the submit event, so no re-entry.)
          e.preventDefault();
          if (f.dataset.plSticky) return;
          f.dataset.plSticky = '1';
          var go = function () { f.submit(); };
          var done = false;
          var once = function () { if (!done) { done = true; go(); } };
          window.plausible('Sticky ATC', { callback: once });
          setTimeout(once, 500);
        } else if (f.closest('product-form')) {
          // Main product add-to-cart (fetch-based in Dawn, no navigation).
          window.plausible('Add to Cart');
        }
      }, true);
    </script>
    ${PL_END}`;

const results = [];

// ===== ÉTAPE 2 + Messenger goal — layout/theme.liquid =====
{
  const key = "layout/theme.liquid";
  let v = await getAsset(key);
  backup("theme.liquid", v);
  let changed = false;

  // One-time migration: strip the original unmarked block (pre-markers, dual-domain).
  // Bounded from the legacy comment through the end of its addEventListener `}, true);</script>`.
  const legacyRe = /\s*<!-- Plausible Analytics \(cookieless[\s\S]*?\}, true\);\s*<\/script>/;
  if (legacyRe.test(v) && !v.includes(PL_START)) {
    v = v.replace(legacyRe, "");
    console.log("✓ theme.liquid: stripped legacy (unmarked) Plausible block for migration");
  }

  const blockRe = new RegExp(`${PL_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${PL_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (blockRe.test(v)) {
    // Replace existing managed block in place (lets us iterate on the snippet).
    const next = v.replace(blockRe, PLAUSIBLE_HEAD);
    if (next !== v) { v = next; changed = true; console.log("✓ theme.liquid: Plausible <head> block updated in place"); }
    else console.log("• theme.liquid: Plausible <head> block already current");
  } else if (v.includes("plausible.io")) {
    throw new Error("theme.liquid: found plausible.io but not the managed markers — manual cleanup needed");
  } else {
    const anchor = "{% render 'meta-tags' %}";
    if (!v.includes(anchor)) throw new Error("theme.liquid: meta-tags anchor not found");
    v = v.replace(anchor, `${anchor}\n\n    ${PLAUSIBLE_HEAD}`);
    changed = true;
    console.log("✓ theme.liquid: Plausible <head> block injected after meta-tags");
  }

  // Messenger floating button goal (it's an <a> link → tagged-events is reliable here).
  if (!v.includes("plausible-event-name=Messenger")) {
    const before = v;
    v = v.replace('class="lc-msgr"', 'class="lc-msgr plausible-event-name=Messenger+Click"');
    if (v === before) throw new Error("theme.liquid: .lc-msgr anchor not matched (theme drifted?)");
    changed = true;
    console.log("✓ theme.liquid: Messenger goal tagged on .lc-msgr");
  } else console.log("• theme.liquid: Messenger goal already tagged");

  if (changed && !DRY) { await putAsset(key, v); console.log("  → theme.liquid written"); }
  results.push([key, changed]);
}

// ===== ÉTAPE 3 — Hero CTA goal in templates/index.json (lc_hero) =====
// Surgical string replace on the raw file so we don't re-serialize the whole template.
{
  const key = "templates/index.json";
  const raw = await getAsset(key);
  backup("index.json", raw);
  let out = raw;
  let changed = false;
  if (raw.includes("plausible-event-name=Hero")) {
    console.log("• index.json: Hero CTA goal already tagged");
  } else {
    const needle = 'class=\\"lc-btn\\"';
    if (!raw.includes(needle)) throw new Error("index.json: .lc-btn anchor not matched (theme drifted?)");
    out = raw.replace(needle, 'class=\\"lc-btn plausible-event-name=Hero+CTA\\"');
    changed = true;
    console.log("✓ index.json: Hero CTA goal tagged on .lc-btn");
  }
  if (changed && !DRY) { JSON.parse(out); await putAsset(key, out); console.log("  → index.json written"); }
  results.push([key, changed]);
}

// ===== ÉTAPE 3 — Sticky ATC in templates/product.json =====
// Handled via JS in the <head> block, NOT a tagged class. If a previous run tagged
// the button, strip it so we don't double-count.
{
  const key = "templates/product.json";
  const raw = await getAsset(key);
  backup("product.json", raw);
  let out = raw;
  let changed = false;
  const tagged = ' class=\\"plausible-event-name=Sticky+ATC\\"';
  if (raw.includes(tagged)) {
    out = raw.replace(tagged, "");
    changed = true;
    console.log("✓ product.json: removed stale Sticky ATC tagged class (now handled in JS)");
  } else {
    console.log("• product.json: no tagged class (Sticky ATC handled in JS) — OK");
  }
  if (changed && !DRY) { JSON.parse(out); await putAsset(key, out); console.log("  → product.json written"); }
  results.push([key, changed]);
}

console.log(`\n[${DRY ? "DRY" : "DONE"}] theme ${PREVIEW_THEME_ID}`);
console.log(results.map(([k, c]) => `  ${c ? "changed" : "no-op "} ${k}`).join("\n"));
