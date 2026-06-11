// Phase 6 C1 — warmer Québécois marketing voice on the homepage. PREVIEW only (160213696617).
// Idempotent string replacements + section setting updates. PUT index.json + header-group.json.
import { rest, sleep } from "./_shopify-lib.mjs";
const T = "160213696617";
if (T === "160059195497") throw new Error("refusing to run against the LIVE theme");
const get = async (k) => (await (await rest(`/themes/${T}/assets.json?asset[key]=${encodeURIComponent(k)}`)).json()).asset.value;
async function put(k, v) {
  const r = await rest(`/themes/${T}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: { key: k, value: v } }) });
  if (!r.ok) throw new Error(`put ${k}: ${r.status} ${await r.text()}`);
  await sleep(550);
  return r.status;
}
const log = [];

// ── index.json ──
const idx = JSON.parse(await get("templates/index.json"));

// 1. featured_sale subtitle (native section description = FR primary; monolingual setting)
const fs = idx.sections.featured_sale;
if (fs) {
  fs.settings.description = "<p>Des prix imbattables sur nos coups de cœur du moment.</p>";
  fs.settings.show_description = true;
  log.push("featured_sale: subtitle set + shown");
}

// 2. why_us — 4 warmer titles
const whyReplace = [
  ["Catalogue de 490+ produits", "Plus de 490 produits pour tous les espaces"],
  ["Livraison gratuite au Canada", "Livraison gratuite partout au Canada"],
  ["Retours faciles 30 jours", "Retours faciles, sans tracas"],
  ["Service client québécois", "On est d'ici. On vous répond en français."],
];
let why = idx.sections.why_us.settings.custom_liquid;
for (const [a, b] of whyReplace) if (why.includes(a)) { why = why.replaceAll(a, b); log.push(`why_us: "${a}" → "${b}"`); }
idx.sections.why_us.settings.custom_liquid = why;

// 3. shop_pay_home — light naturalness tweaks (both locales)
const spReplace = [
  ["0 % d'intérêt", "Aucun intérêt"],
  ["0% interest", "No interest"],
  ["Approbation rapide", "Approbation instantanée"],
  ["Fast approval", "Instant approval"],
];
let sp = idx.sections.shop_pay_home.settings.custom_liquid;
for (const [a, b] of spReplace) if (sp.includes(a)) { sp = sp.replaceAll(a, b); log.push(`shop_pay: "${a}" → "${b}"`); }
idx.sections.shop_pay_home.settings.custom_liquid = sp;

JSON.parse(JSON.stringify(idx));
log.push(`PUT templates/index.json → ${await put("templates/index.json", JSON.stringify(idx, null, 2))}`);

// ── header-group.json — announcement bar ──
const hg = JSON.parse(await get("sections/header-group.json"));
const ann = "Livraison gratuite au Canada · Retours 30 jours · Paiement sécurisé";
for (const b of Object.values(hg.sections["announcement-bar"].blocks)) {
  if (b?.settings?.text && /Livraison gratuite au Canada/.test(b.settings.text) && b.settings.text !== ann) {
    b.settings.text = ann; log.push(`announcement: → "${ann}"`);
  }
}
log.push(`PUT sections/header-group.json → ${await put("sections/header-group.json", JSON.stringify(hg, null, 2))}`);

console.log(log.join("\n"));
console.log(`\nDone on PREVIEW ${T}. EN note: featured_sale subtitle is a native (monolingual) setting → FR shown; EN parity = theme translation follow-up.`);
