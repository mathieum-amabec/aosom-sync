// Migrate the preview copy theme 160059195497 from Plausible to Umami Cloud.
//  - ÉTAPE 1: remove the Plausible <head> block.
//  - ÉTAPE 2: add the Umami Cloud script. The website-id is read from .env.local
//      (UMAMI_WEBSITE_ID); if unset it falls back to UMAMI_WEBSITE_ID_PLACEHOLDER so
//      the integration is visible before Mat creates the account. Reading it from env
//      (not a hardcoded const) means re-running the script PRESERVES a real id instead
//      of clobbering it back to the placeholder.
//  - ÉTAPE 3: migrate the 4 custom events:
//      Hero CTA        — data-umami-event on the .lc-btn <a>
//      Messenger Click — data-umami-event on the .lc-msgr <a>
//      Sticky ATC      — umami.track() in JS before the full-page POST, 500ms failsafe
//      Add to Cart     — umami.track() in JS, scoped to Dawn <product-form>
//    All window.plausible() / plausible-event-name=... references are removed.
//
// Umami notes:
//  - <a>/element clicks: declarative data-umami-event="Name" (Umami auto-binds on click).
//  - Sticky button submits a PLAIN <form> (full-page POST → /checkout). A data attribute
//    would race page-unload, so we track in JS and submit on track()'s promise (or a 500ms
//    failsafe if Umami is blocked/not yet loaded). Umami has NO pre-load queue, so calls are
//    guarded with `typeof window.umami.track === 'function'`. Consequence: clicks that fire
//    before the deferred script loads are not counted (documented in UMAMI-SETUP.md).
//  - The 4 events appear in Umami automatically — no manual goal creation (unlike Plausible).
//
// Idempotent: re-running replaces the managed block in place; migrating from a live
// Plausible install strips the old block + tagged classes. All three assets are validated
// in memory and only written if ALL transforms succeed (no half-applied state). Backs up
// each asset first.
import { getAsset, putAsset, loadEnv, PREVIEW_THEME_ID } from "./_shopify-lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");
const reportsDir = join(__dirname, "reports");
mkdirSync(reportsDir, { recursive: true });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const backup = (name, value) => writeFileSync(join(reportsDir, `${name}.umami-backup.txt`), value, "utf8");

// Specific Plausible tokens we expect to have removed — narrow on purpose so an
// unrelated occurrence of the word "plausible" elsewhere can't wedge the migration.
const PLAUSIBLE_TOKENS = /plausible\.io|window\.plausible|plausible-event-name/i;

const UM_START = "<!-- Umami Analytics: START (managed by scripts/apply-umami.mjs) -->";
const UM_END = "<!-- Umami Analytics: END -->";
const PLACEHOLDER = "UMAMI_WEBSITE_ID_PLACEHOLDER";
const WEBSITE_ID = (loadEnv().UMAMI_WEBSITE_ID || "").trim() || PLACEHOLDER;
const USING_PLACEHOLDER = WEBSITE_ID === PLACEHOLDER;

const UMAMI_HEAD = `${UM_START}
    <!-- Cookieless, conforme Loi 25 (Québec) — aucune bannière de cookies requise. -->
    <!-- website-id: défini via UMAMI_WEBSITE_ID dans .env.local, sinon placeholder (voir docs/UMAMI-SETUP.md). -->
    <script defer src="https://cloud.umami.is/script.js" data-website-id="${WEBSITE_ID}"></script>
    <script>
      document.addEventListener('submit', function (e) {
        var f = e.target;
        if (!f || !f.matches || !f.matches('form[action*="/cart/add"]')) return;
        var hasUmami = window.umami && typeof window.umami.track === 'function';
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
            if (hasUmami) {
              var r = window.umami.track('Sticky ATC');
              if (r && typeof r.then === 'function') r.then(once, once);
            }
          } catch (err) {}
          setTimeout(once, 500);
        } else if (f.closest('product-form')) {
          // Main product add-to-cart (fetch-based in Dawn, no navigation).
          try { if (hasUmami) window.umami.track('Add to Cart'); } catch (err) {}
        }
      }, true);
    </script>
    ${UM_END}`;

// ---- transform each asset in memory; write only if ALL succeed ----
const writes = [];

// theme.liquid: strip Plausible block, add/refresh Umami block, migrate Messenger event.
{
  const key = "layout/theme.liquid";
  let v = await getAsset(key);
  backup("theme.liquid", v);
  let changed = false;

  const plausibleRe = /\s*<!-- Plausible Analytics: START[\s\S]*?<!-- Plausible Analytics: END -->/;
  if (plausibleRe.test(v)) { v = v.replace(plausibleRe, ""); changed = true; console.log("✓ theme.liquid: removed Plausible <head> block"); }
  const legacyRe = /\s*<!-- Plausible Analytics \(cookieless[\s\S]*?\}, true\);\s*<\/script>/;
  if (legacyRe.test(v)) { v = v.replace(legacyRe, ""); changed = true; console.log("✓ theme.liquid: removed stray legacy Plausible block"); }

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

  if (v.includes('class="lc-msgr plausible-event-name=Messenger+Click"')) {
    v = v.replace('class="lc-msgr plausible-event-name=Messenger+Click"', 'class="lc-msgr" data-umami-event="Messenger Click"');
    changed = true; console.log("✓ theme.liquid: Messenger event migrated to data-umami-event");
  } else if (v.includes('data-umami-event="Messenger Click"')) {
    console.log("• theme.liquid: Messenger already on data-umami-event");
  } else if (v.includes('class="lc-msgr"')) {
    v = v.replace('class="lc-msgr"', 'class="lc-msgr" data-umami-event="Messenger Click"');
    changed = true; console.log("✓ theme.liquid: Messenger event added (data-umami-event)");
  } else {
    throw new Error("theme.liquid: .lc-msgr anchor not matched (theme drifted?)");
  }

  if (PLAUSIBLE_TOKENS.test(v)) throw new Error("theme.liquid: a Plausible token survived migration — aborting");
  writes.push([key, v, changed]);
}

// index.json: migrate Hero CTA event (raw escaped-string replace; validate JSON always).
{
  const key = "templates/index.json";
  const raw = await getAsset(key);
  backup("index.json", raw);
  let out = raw;
  let changed = false;
  const plausible = 'class=\\"lc-btn plausible-event-name=Hero+CTA\\"';
  const umami = 'class=\\"lc-btn\\" data-umami-event=\\"Hero CTA\\"';
  const assertOne = (hay, needle) => {
    const n = hay.split(needle).length - 1;
    if (n !== 1) throw new Error(`index.json: expected exactly 1 "${needle}", found ${n}`);
  };
  if (raw.includes(plausible)) {
    assertOne(raw, plausible);
    out = raw.replace(plausible, umami); changed = true; console.log("✓ index.json: Hero CTA event migrated to data-umami-event");
  } else if (raw.includes('data-umami-event=\\"Hero CTA\\"')) {
    console.log("• index.json: Hero CTA already on data-umami-event");
  } else if (raw.includes('class=\\"lc-btn\\"')) {
    assertOne(raw, 'class=\\"lc-btn\\"');
    out = raw.replace('class=\\"lc-btn\\"', umami); changed = true; console.log("✓ index.json: Hero CTA event added (data-umami-event)");
  } else {
    throw new Error("index.json: .lc-btn anchor not matched (theme drifted?)");
  }
  JSON.parse(out); // validate every run, including --dry
  if (PLAUSIBLE_TOKENS.test(out)) throw new Error("index.json: a Plausible token survived migration — aborting");
  writes.push([key, out, changed]);
}

// product.json: defensively strip any leftover Plausible Sticky tag (Sticky handled in JS).
{
  const key = "templates/product.json";
  const raw = await getAsset(key);
  backup("product.json", raw);
  let out = raw;
  let changed = false;
  const stale = ' class=\\"plausible-event-name=Sticky+ATC\\"';
  if (raw.includes(stale)) { out = raw.replace(stale, ""); changed = true; console.log("✓ product.json: removed stale Plausible Sticky tag"); }
  else console.log("• product.json: clean (Sticky ATC handled in JS) — OK");
  JSON.parse(out);
  if (PLAUSIBLE_TOKENS.test(out)) throw new Error("product.json: a Plausible token survived migration — aborting");
  writes.push([key, out, changed]);
}

// ---- all transforms validated; write now ----
if (USING_PLACEHOLDER) {
  console.warn(`\n⚠ WEBSITE-ID = PLACEHOLDER. Umami will 404 (no data) until Mat sets UMAMI_WEBSITE_ID`);
  console.warn(`  in .env.local and re-runs this script, OR replaces ${PLACEHOLDER} in the live theme.`);
} else {
  console.log(`\n✓ WEBSITE-ID = real id from .env.local (${WEBSITE_ID.slice(0, 8)}…)`);
}

for (const [key, value, changed] of writes) {
  if (changed && !DRY) { await putAsset(key, value); console.log(`  → ${key} written`); }
}

console.log(`\n[${DRY ? "DRY" : "DONE"}] theme ${PREVIEW_THEME_ID}`);
console.log(writes.map(([k, , c]) => `  ${c ? "changed" : "no-op "} ${k}`).join("\n"));
