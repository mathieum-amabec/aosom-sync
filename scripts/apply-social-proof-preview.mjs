// B4 — fix duplicate "500" social-proof numbers on the PREVIEW theme 160213696617.
// HARD GUARD: refuses to touch the live theme. Idempotent; verifies each replacement.
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";

const LIVE = "160059195497";
const PREVIEW = "160213696617";
if (PREVIEW === LIVE) throw new Error("ABORT: preview equals live");
const t = (await (await rest("/themes.json")).json()).themes.find((x) => String(x.id) === PREVIEW);
if (!t || t.role !== "unpublished") throw new Error(`ABORT: theme ${PREVIEW} not an unpublished preview`);
console.log(`Target preview: ${t.id} "${t.name}" [${t.role}]`);

const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));

// (section, old, new) replacements
const edits = [
  ["lc_hero", "500+ products", "490+ products"],
  ["lc_hero", "Plus de 500 produits", "Plus de 490 produits"],
  ["lc_howit", "500+ products", "490+ products"],
  ["lc_howit", "500+ produits", "490+ produits"],
  ["lc_trust", "Over 500 Canadian families trust us", "30-day satisfaction guarantee"],
  ["lc_trust", "Plus de 500 familles canadiennes nous font confiance", "Satisfaction garantie 30 jours"],
];

let applied = 0, skipped = 0;
for (const [sec, oldS, newS] of edits) {
  const block = idx.sections[sec]?.settings;
  if (!block || typeof block.custom_liquid !== "string") throw new Error(`ABORT: section ${sec} custom_liquid missing`);
  if (block.custom_liquid.includes(newS) && !block.custom_liquid.includes(oldS)) {
    console.log(`= ${sec}: already has "${newS.slice(0, 30)}" — skip`);
    skipped++;
    continue;
  }
  if (!block.custom_liquid.includes(oldS)) throw new Error(`ABORT: "${oldS}" not found in ${sec}`);
  block.custom_liquid = block.custom_liquid.split(oldS).join(newS);
  console.log(`+ ${sec}: "${oldS.slice(0, 40)}" -> "${newS.slice(0, 40)}"`);
  applied++;
}

if (applied > 0) {
  await putAsset("templates/index.json", JSON.stringify(idx, null, 2), PREVIEW);
  console.log(`\nindex.json PUT 200 (preview) — ${applied} replacements, ${skipped} already-applied`);
} else {
  console.log(`\nNo changes to PUT (${skipped} already-applied)`);
}
