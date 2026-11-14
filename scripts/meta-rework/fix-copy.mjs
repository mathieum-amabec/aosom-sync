// 2026-11-04 follow-up: qualified shipping wording + "des milliers" on the PAUSED evergreen ad.
// Creatives are immutable -> new creative, then repoint the PAUSED ad. Never touches status.
//   node scripts/meta-rework/fix-copy.mjs           # dry-run
//   node scripts/meta-rework/fix-copy.mjs --apply
import fs from "node:fs";
import { get, post } from "./_graph.mjs";

const APPLY = process.argv.includes("--apply");
const ACT = "act_20658834";
const ADS = ["52607877328405", "52607877334605"];
const EVERGREEN_AD = "52607877328405";
const BACKUP = "C:/Users/vente/Documents/aosom-sync-backups/meta-2026-11-04-copyfix-before.json";
const SHIP = "Livraison gratuite au Canada (sauf certaines régions éloignées).";

const APPROVED = `On saute le magasin. Tu sautes le prix.\n\nPas de magasin, pas de loyer, pas de vendeur à commission. Juste le produit, importé directement du fabricant, livré chez toi. Des milliers de produits en stock.\n\n${SHIP}`;
const BUY2 = `Achète 2 articles : 10 % de rabais sur le moins cher des deux, appliqué automatiquement au panier. Aucun code.\n\nMeubles, rangement, patio, déco : des milliers de produits.\n\n${SHIP}`;

const FIELDS = "id,name,status,effective_status,adset_id,campaign_id,creative{id,name,object_story_spec,asset_feed_spec,url_tags,product_set_id,degrees_of_freedom_spec}";
const before = {};
for (const id of ADS) before[id] = await get(id, { fields: FIELDS });
fs.writeFileSync(BACKUP, JSON.stringify({ saved_at: new Date().toISOString(), ads: before }, null, 2));
console.log("backup ->", BACKUP);
for (const [id, a] of Object.entries(before)) console.log(id, a.status, a.creative.id, a.creative.name);

// The Vendredi fou body already carries the qualified wording and no product count: unchanged.
const bf = before["52607877334605"].creative.asset_feed_spec.bodies.map((b) => b.text).join("\n");
console.log("vendredi fou already qualified:", bf.includes("sauf certaines régions éloignées"));

const old = before[EVERGREEN_AD].creative;
const tpl = { ...old.object_story_spec.template_data, message: APPROVED };
const creative = {
  name: "Ameublo — Advantage+ Ventes QC — on saute le magasin — 2026-11 v2 (livraison qualifiée)",
  product_set_id: old.product_set_id,
  url_tags: old.url_tags,
  object_story_spec: { ...old.object_story_spec, template_data: tpl },
  asset_feed_spec: { ...old.asset_feed_spec, bodies: [{ text: APPROVED }, { text: BUY2 }] },
  degrees_of_freedom_spec: { creative_features_spec: {
    adapt_to_placement: { enroll_status: "OPT_IN" },
    standard_enhancements_catalog: { enroll_status: "OPT_IN" },
  } },
};
console.log("\nnew bodies:\n---\n" + APPROVED + "\n---\n" + BUY2 + "\n---");
if (!APPLY) { console.log("dry-run: nothing sent"); process.exit(0); }

const cr = await post(`${ACT}/adcreatives`, creative);
console.log("new creative", cr.id);
await post(EVERGREEN_AD, { creative: { creative_id: cr.id } }); // creative only, status untouched
for (const id of ADS) {
  const a = await get(id, { fields: "id,status,effective_status,creative{id}" });
  console.log("after", id, a.status, a.effective_status, a.creative.id);
  if (a.status !== "PAUSED") { console.error(`!!! ${id} is ${a.status} — pausing`); await post(id, { status: "PAUSED" }); }
}
