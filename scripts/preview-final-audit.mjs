// CHANTIER 1 — read-only final visual audit of the preview theme.
import { getAsset } from "./_shopify-lib.mjs";
const P = "160213696617";
const targets = [
  "templates/index.json",
  "sections/header-group.json",
  "sections/featured-collection.liquid",
  "snippets/mega-menu.liquid",
  "layout/theme.liquid",
];
const EMOJI = /🚚|🔄|🔒|⭐|🔥|📦|🛋️|✨|💳|🔔|🏠|🌿|🐾|🛒/gu;
const cache = {};
for (const k of targets) { try { cache[k] = await getAsset(k, P); } catch { cache[k] = null; console.log(`(missing: ${k})`); } }

// 1. "livraison gratuite"
console.log('=== 1. "livraison gratuite" ===');
for (const [k, v] of Object.entries(cache)) {
  if (!v) continue;
  if (k === "templates/index.json") {
    const idx = JSON.parse(v);
    for (const [id, sec] of Object.entries(idx.sections)) {
      const c = (JSON.stringify(sec).match(/livraison gratuite/gi) || []).length;
      if (c) console.log(`  ${k} → ${id} [${sec.type}]: ${c}×`);
    }
  } else {
    const c = (v.match(/livraison gratuite/gi) || []).length;
    if (c) console.log(`  ${k}: ${c}×`);
  }
}

// 2. emojis
console.log("\n=== 2. emojis (🚚🔄🔒⭐🔥 + others) ===");
for (const [k, v] of Object.entries(cache)) {
  if (!v) continue;
  const m = v.match(EMOJI);
  if (m) console.log(`  ${k}: ${m.length}× → ${[...new Set(m)].join(" ")}`);
}

// 3. ALL-CAPS marketing (3+ consecutive all-caps words, accents incl.)
console.log("\n=== 3. ALL-CAPS marketing runs ===");
const capsRe = /\b[A-ZÀ-ÖØ-Þ]{2,}(?:[ '|·/-]+[A-ZÀ-ÖØ-Þ]{2,}){1,}\b/g;
for (const [k, v] of Object.entries(cache)) {
  if (!v) continue;
  const hits = [...new Set((v.match(capsRe) || []).filter((s) => !/^(SVG|HTML|DM|CTA|SSL|BTU|UTF|JSON|API|URL|FAQ|SKU|XML|RX|XX)$/.test(s.replace(/[ '|·/-].*/, ""))))];
  const real = hits.filter((s) => s.replace(/[^A-ZÀ-Þ]/g, "").length >= 6);
  if (real.length) real.forEach((s) => console.log(`  ${k}: "${s.slice(0, 70)}"`));
}

// 4. home sections — flag potentially redundant/empty
console.log("\n=== 4. home sections (redundancy/empty review) ===");
const idx = JSON.parse(cache["templates/index.json"]);
idx.order.forEach((id, i) => {
  const s = idx.sections[id];
  const cl = s.settings?.custom_liquid || "";
  const empty = s.type === "custom-liquid" && cl.replace(/\s/g, "").length < 40;
  console.log(`  ${String(i + 1).padStart(2)}. ${id} [${s.type}]${empty ? "  ⚠️ EMPTY/near-empty" : ""}`);
});
console.log("\norder count:", idx.order.length);
