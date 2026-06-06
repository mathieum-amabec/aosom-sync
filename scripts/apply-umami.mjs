// Migrate the preview copy theme 160059195497 from Plausible to Umami Cloud.
//  - ÉTAPE 1: remove the Plausible <head> block.
//  - ÉTAPE 2: add the Umami Cloud script with a clearly-marked website-id placeholder.
//  - ÉTAPE 3: migrate the 4 custom events:
//      Hero CTA        — data-umami-event on the .lc-btn <a>      (was plausible tagged class)
//      Messenger Click — data-umami-event on the .lc-msgr <a>     (was plausible tagged class)
//      Sticky ATC      — umami.track() in JS before the full-page POST, with 500ms failsafe
//      Add to Cart     — umami.track() in JS, scoped to Dawn <product-form>
//    All window.plausible() / plausible-event-name=... references are removed.
//
// Umami notes:
//  - <a>/element clicks: declarative data-umami-event="Name" (Umami auto-binds on click).
//  - Sticky button submits a PLAIN <form> (full-page POST → /checkout). A data attribute
//    would race page-unload, so we track in JS and submit on the track() promise (or a
//    500ms failsafe if Umami is blocked/not yet loaded). Umami has no pre-load queue, so
//    every umami call is guarded with `typeof window.umami.track === 'function'`.
//  - The 4 events appear in Umami automatically — no manual goal creation (unlike Plausible).
//
// Idempotent: re-running replaces the managed block in place; migrating from a live
// Plausible install strips the old block + tagged classes. Backs up each asset first.
import { getAsset, putAsset, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function backup(name, value) {
  writeFileSync(join(reportsDir, `${name}.umami-backup.txt`), value, "utf8");
}

const UM_START = "<!-- Umami Analytics: START (managed by scripts/apply-umami.mjs) -->";
const UM_END = "<!-- Umami Analytics: END -->";
const PLACEHOLDER = "UMAMI_WEBSITE_ID_PLACEHOLDER";

const UMAMI_HEAD = `${UM_START}
    <!-- Cookieless, conforme Loi 25 (Québec) — aucune bannière de cookies requise. -->
    <!-- TODO Mat: remplacer ${PLACEHOLDER} par le vrai website-id (cloud.umami.is → voir docs/UMAMI-SETUP.md). -->
    <script defer src="https://cloud.umami.is/script.js" data-website-id="${PLACEHOLDER}"></script>
    <script>
      document.addEventListener('submit', function (e) {
        var f = e.target;
        if (!f || !f.matches || !f.matches('form[action*="/cart/add"]')) return;
        var track = (window.umami && typeof window.umami.track === 'function') ? window.umami.track : null;
        if (f.closest('#mobile-sticky-atc')) {
          // Sticky bar does a full-page POST → /checkout. Track first, then submit, so the
          // event isn't lost to page-unload. Failsafe submits anyway if Umami is blocked or
          // hasn't loaded. (form.submit() does NOT re-fire the submit event, so no re-entry.)
          e.preventDefault();
          if (f.dataset.umSticky) return;
          f.dataset.umSticky = '1';
          var go = function () { f.submit(); };
          var done = false;
          var once = function () { if (!done) { done = true; go(); } };
          try {
            if (track) {
              var r = track('Sticky ATC');
              if (r && typeof r.then === 'function') r.then(once, once);
            }
          } catch (err) {}
          setTimeout(once, 500);
        } else if (f.closest('product-form')) {
          // Main product add-to-cart (fetch-based in Dawn, no navigation).
          try { if (track) track('Add to Cart'); } catch (err) {}
        }
      }, true);
    </script>
    ${UM_END}`;

const results = [];

// ===== theme.liquid: head block + Messenger event =====
{
  const key = "layout/theme.liquid";
  let v = await getAsset(key);
  backup("theme.liquid", v);
  let changed = false;

  // 1) Remove the Plausible managed block if present (ÉTAPE 1).
  const plausibleRe = /\s*<!-- Plausible Analytics: START[\s\S]*?<!-- Plausible Analytics: END -->/;
  if (plausibleRe.test(v)) {
    v = v.replace(plausibleRe, "");
    changed = true;
    console.log("✓ theme.liquid: removed Plausible <head> block");
  }
  // Safety net: any stray legacy unmarked Plausible block.
  const legacyRe = /\s*<!-- Plausible Analytics \(cookieless[\s\S]*?\}, true\);\s*<\/script>/;
  if (legacyRe.test(v)) { v = v.replace(legacyRe, ""); changed = true; console.log("✓ theme.liquid: removed stray legacy Plausible block"); }

  // 2) Add / update the Umami managed block (ÉTAPE 2 + 3 JS).
  const umamiRe = new RegExp(`${esc(UM_START)}[\\s\\S]*?${esc(UM_END)}`);
  if (umamiRe.test(v)) {
    const next = v.replace(umamiRe, UMAMI_HEAD);
    if (next !== v) { v = next; changed = true; console.log("✓ theme.liquid: Umami <head> block updated in place"); }
    else console.log("• theme.liquid: Umami <head> block already current");
  } else {
    const anchor = "{% render 'meta-tags' %}";
    if (!v.includes(anchor)) throw new Error("theme.liquid: meta-tags anchor not found");
    v = v.replace(anchor, `${anchor}\n\n    ${UMAMI_HEAD}`);
    changed = true;
    console.log("✓ theme.liquid: Umami <head> block injected after meta-tags");
  }

  // 3) Messenger event (ÉTAPE 3): plausible tagged class → data-umami-event.
  if (v.includes('class="lc-msgr plausible-event-name=Messenger+Click"')) {
    v = v.replace('class="lc-msgr plausible-event-name=Messenger+Click"', 'class="lc-msgr" data-umami-event="Messenger Click"');
    changed = true;
    console.log("✓ theme.liquid: Messenger event migrated to data-umami-event");
  } else if (v.includes('data-umami-event="Messenger Click"')) {
    console.log("• theme.liquid: Messenger already on data-umami-event");
  } else if (v.includes('class="lc-msgr"')) {
    // Plausible class absent and umami attr absent → add the umami attr.
    v = v.replace('class="lc-msgr"', 'class="lc-msgr" data-umami-event="Messenger Click"');
    changed = true;
    console.log("✓ theme.liquid: Messenger event added (data-umami-event)");
  } else {
    throw new Error("theme.liquid: .lc-msgr anchor not matched (theme drifted?)");
  }

  if (v.includes("plausible")) throw new Error("theme.liquid: 'plausible' still present after migration — aborting");
  if (changed && !DRY) { await putAsset(key, v); console.log("  → theme.liquid written"); }
  results.push([key, changed]);
}

// ===== index.json: Hero CTA event (raw string replace, no re-serialization) =====
{
  const key = "templates/index.json";
  const raw = await getAsset(key);
  backup("index.json", raw);
  let out = raw;
  let changed = false;
  const plausible = 'class=\\"lc-btn plausible-event-name=Hero+CTA\\"';
  const umami = 'class=\\"lc-btn\\" data-umami-event=\\"Hero CTA\\"';
  if (raw.includes(plausible)) {
    out = raw.replace(plausible, umami);
    changed = true;
    console.log("✓ index.json: Hero CTA event migrated to data-umami-event");
  } else if (raw.includes('data-umami-event=\\"Hero CTA\\"')) {
    console.log("• index.json: Hero CTA already on data-umami-event");
  } else if (raw.includes('class=\\"lc-btn\\"')) {
    out = raw.replace('class=\\"lc-btn\\"', umami);
    changed = true;
    console.log("✓ index.json: Hero CTA event added (data-umami-event)");
  } else {
    throw new Error("index.json: .lc-btn anchor not matched (theme drifted?)");
  }
  if (out.includes("plausible")) throw new Error("index.json: 'plausible' still present after migration — aborting");
  if (changed && !DRY) { JSON.parse(out); await putAsset(key, out); console.log("  → index.json written"); }
  results.push([key, changed]);
}

// ===== product.json: defensively strip any leftover Plausible Sticky tag =====
{
  const key = "templates/product.json";
  const raw = await getAsset(key);
  backup("product.json", raw);
  let out = raw;
  let changed = false;
  const stale = ' class=\\"plausible-event-name=Sticky+ATC\\"';
  if (raw.includes(stale)) {
    out = raw.replace(stale, "");
    changed = true;
    console.log("✓ product.json: removed stale Plausible Sticky tag");
  } else {
    console.log("• product.json: clean (Sticky ATC handled in JS) — OK");
  }
  if (out.includes("plausible")) throw new Error("product.json: 'plausible' still present after migration — aborting");
  if (changed && !DRY) { JSON.parse(out); await putAsset(key, out); console.log("  → product.json written"); }
  results.push([key, changed]);
}

console.log(`\n[${DRY ? "DRY" : "DONE"}] theme ${PREVIEW_THEME_ID}`);
console.log(results.map(([k, c]) => `  ${c ? "changed" : "no-op "} ${k}`).join("\n"));
