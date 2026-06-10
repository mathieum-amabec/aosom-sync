// Chantier 3 (A2) — product-card fixes, PREVIEW THEME ONLY.
//
// Target theme: 160213696617 "Copie de Copie de Trade v2" (UNPUBLISHED).
// NEVER the live theme 160059195497.
//
// Fix applied: remove the quantity +/- steppers from product cards. They appear only
// when a section uses `quick_add: "bulk"` (single-variant -> card-product.liquid renders
// `quantity-input`). Switching those sections to `quick_add: "standard"` keeps a single
// add-to-cart button and drops the stepper. Quantity belongs on the PDP, not the card.
//
// NOT applied: hiding the "Default Title" variant label. A full theme scan found NO
// visible `variant.title` render on cards (only aria-labels, already de-verbosed in
// Chantier 2). There is nothing to guard with `{% unless variant.title == 'Default
// Title' %}`. Awaiting an example card URL from Mat. See DATA-OPS-LOG.
//
// Idempotent. Run:  node scripts/preview-card-fixes.mjs
import { rest, sleep } from "./_shopify-lib.mjs";

const THEME = "160213696617";
if (THEME === "160059195497") throw new Error("refusing to run against the LIVE theme");

async function get(key) {
  const r = await rest(`/themes/${THEME}/assets.json?asset[key]=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`get ${key}: ${r.status}`);
  return (await r.json()).asset.value;
}
async function put(key, value) {
  const r = await rest(`/themes/${THEME}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key, value } }) });
  if (!r.ok) throw new Error(`put ${key}: ${r.status} ${await r.text()}`);
  await sleep(550);
}

// Find every JSON template / section-group asset that sets quick_add:"bulk".
const list = await (await rest(`/themes/${THEME}/assets.json`)).json();
const jsonKeys = list.assets.map((a) => a.key).filter((k) => /^(templates|sections)\/.*\.json$/.test(k));

let changed = 0, skipped = 0, scanned = 0;
for (const key of jsonKeys) {
  const v = await get(key);
  scanned++;
  if (!/"quick_add"\s*:\s*"bulk"/.test(v)) { await sleep(250); continue; }
  JSON.parse(v); // validate before
  const out = v.replace(/("quick_add"\s*:\s*)"bulk"/g, '$1"standard"');
  JSON.parse(out); // validate after
  await put(key, out);
  const n = (v.match(/"quick_add"\s*:\s*"bulk"/g) || []).length;
  console.log(`✔ ${key}: ${n} card section(s) bulk -> standard (steppers removed)`);
  changed++;
}
if (changed === 0) console.log("• no quick_add:bulk found — steppers already removed");

console.log(`\nScanned ${scanned} JSON assets. ${changed} file(s) changed.`);
console.log("Preview: https://27u5y2-kp.myshopify.com/?preview_theme_id=" + THEME);
