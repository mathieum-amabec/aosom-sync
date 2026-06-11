// Chantier 2 — DRY-RUN: EN-title parity for the 7 products cleaned in A1 (FR brands removed).
// Read-only. Pulls each product's EN title from BOTH the Translations API and the
// custom.title_en metafield, applies the SAME brand-strip cleaning, and reports before/after.
// No writes.
import { gql } from "./_shopify-lib.mjs";

const IDS = ["7736547475561", "7736568971369", "7736571494505", "7736571592809",
  "7736576901225", "7736577228905", "7752208449641"];

// Same brand set + cleaning as scripts/brand-cleanup-dry-run.mjs (A1).
const BRANDS = ["Outsunny", "HOMCOM", "Aosom", "Vinsetto", "Kleankin", "Zonekiz",
  "Soozier", "Qaba", "PawHut", "Sportnow", "Aiyaplay", "Rosefray"];
const ordered = [...BRANDS].sort((a, b) => b.length - a.length);
const detectRe = new RegExp("\\b(" + ordered.join("|") + ")\\b", "i");
const stripRe = new RegExp("\\b(" + ordered.join("|") + ")\\b", "gi");
function cleanTitle(t) {
  if (!t) return t;
  let s = t.replace(stripRe, "");
  s = s.replace(/\s+/g, " ").replace(/\s*,\s*,\s*/g, ", ").replace(/\s+,/g, ",").replace(/,(?=\S)/g, ", ");
  s = s.replace(/(?:\s[–—-]){2,}\s/g, " — ").replace(/\s+/g, " ");
  s = s.replace(/^[\s,–—-]+/, "").replace(/[\s,–—-]+$/, "");
  return s.trim();
}

const Q = `query($ids:[ID!]!){
  nodes(ids:$ids){
    ... on Product {
      legacyResourceId
      title
      metafield(namespace:"custom", key:"title_en"){ value }
      translations(locale:"en"){ key value }
    }
  }
}`;

const gids = IDS.map((id) => `gid://shopify/Product/${id}`);
const { data } = await gql(Q, { ids: gids });

console.log("EN-title parity — A1 brand cleanup (DRY-RUN, no writes)\n" + "─".repeat(72));
let changeCount = 0;
const rows = [];
for (const n of data.nodes) {
  const tTrans = (n.translations || []).find((t) => t.key === "title")?.value || "";
  const tMeta = n.metafield?.value || "";
  const enSource = tTrans ? "translation" : (tMeta ? "metafield" : "(none)");
  const enBefore = tTrans || tMeta || "";
  const enAfter = cleanTitle(enBefore);
  const hasBrand = detectRe.test(enBefore);
  const changed = enBefore !== enAfter;
  if (changed) changeCount++;
  rows.push({ id: n.legacyResourceId, fr: n.title, enSource, enBefore, enAfter, hasBrand, changed });
  console.log(`#${n.legacyResourceId}  (EN source: ${enSource})`);
  console.log(`   FR (déjà nettoyé A1) : ${n.title}`);
  console.log(`   EN avant : ${enBefore || "(aucun titre EN)"}`);
  console.log(`   EN après : ${enAfter || "(aucun titre EN)"}${changed ? "   ⟵ CHANGE" : ""}`);
  console.log("");
}
console.log("─".repeat(72));
console.log(`EN titles found: ${rows.filter((r) => r.enBefore).length}/7 | would change: ${changeCount}`);
console.log("DRY-RUN — aucune écriture. STOP — en attente de validation de Mat.");
