// C1 — replace the PDP swatch color map with the full FR+EN map. PREVIEW only (160213696617).
// Idempotent (skips if the new map is already in place). PUT main-product.liquid.
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

const NEW_MAP = "var C={" + [
  // Français
  ["noir", "#1a1a1a"], ["blanc", "#FFFFFF"], ["gris", "#808080"], ["gris clair", "#D3D3D3"],
  ["gris foncé", "#404040"], ["beige", "#F5F5DC"], ["brun", "#8B4513"], ["marron", "#6B3A2A"],
  ["taupe", "#8B7355"], ["crème", "#FFFDD0"], ["ivoire", "#FFFFF0"], ["bleu", "#4169E1"],
  ["bleu marine", "#1B2A4A"], ["bleu ciel", "#87CEEB"], ["vert", "#228B22"], ["vert olive", "#808000"],
  ["sauge", "#8FBC8F"], ["rouge", "#DC143C"], ["bordeaux", "#800020"], ["rose", "#FFB6C1"],
  ["orange", "#FFA500"], ["jaune", "#FFD700"], ["doré", "#D4A853"], ["violet", "#8B008B"],
  ["lavande", "#E6E6FA"], ["turquoise", "#40E0D0"], ["naturel", "#D2B48C"], ["chêne", "#8B6914"],
  ["noyer", "#5C4033"], ["acajou", "#C0392B"], ["bambou", "#DAA520"], ["rotin", "#C19A6B"],
  ["acier", "#708090"], ["argent", "#C0C0C0"], ["bronze", "#CD7F32"], ["cuivre", "#B87333"],
  ["anthracite", "#383E42"], ["charbon", "#36454F"], ["sable", "#C2B280"], ["terre", "#8B6914"],
  ["lin", "#FAF0E6"],
  // English
  ["black", "#1a1a1a"], ["white", "#FFFFFF"], ["gray", "#808080"], ["grey", "#808080"],
  ["light gray", "#D3D3D3"], ["dark gray", "#404040"], ["brown", "#8B4513"], ["cream", "#FFFDD0"],
  ["blue", "#4169E1"], ["navy", "#1B2A4A"], ["green", "#228B22"], ["red", "#DC143C"],
  ["pink", "#FFB6C1"], ["yellow", "#FFD700"], ["gold", "#D4A853"], ["purple", "#8B008B"],
  ["natural", "#D2B48C"], ["oak", "#8B6914"], ["walnut", "#5C4033"], ["steel", "#708090"],
  ["silver", "#C0C0C0"], ["charcoal", "#36454F"], ["sand", "#C2B280"], ["linen", "#FAF0E6"],
  ["khaki", "#F0E68C"], ["kaki", "#C3B091"],
  ["mixed", "linear-gradient(#808080,#D3D3D3)"], ["mixte", "linear-gradient(#808080,#D3D3D3)"],
].map(([k, v]) => `'${k}':'${v}'`).join(",") + "};";

let mp = await get("sections/main-product.liquid");
if (mp.includes("'bleu ciel':'#87CEEB'")) {
  console.log("• swatch map already complete — skipping");
} else {
  const before = mp;
  mp = mp.replace(/var C=\{[\s\S]*?\};/, NEW_MAP);
  if (mp === before) throw new Error("swatch map `var C={...};` not found");
  const count = (NEW_MAP.match(/:/g) || []).length;
  console.log(`✔ swatch map replaced (${count} entries FR+EN)`);
  console.log(`PUT sections/main-product.liquid → HTTP ${await put("sections/main-product.liquid", mp)}`);
}
