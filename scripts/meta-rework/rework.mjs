// 2026-11-04 Meta ads rework — Ameublo Direct (act_20658834).
//
// HARD RULES (owner): never activate anything. Every object created here is PAUSED.
// Only allowed status write on existing objects: PAUSED.
//
//   node scripts/meta-rework/rework.mjs                 # dry-run: prints the plan, sends nothing
//   node scripts/meta-rework/rework.mjs --apply         # pauses + creates (all PAUSED)
//
// Prerequisite: a full JSON backup of the account in C:/Users/vente/Documents/aosom-sync-backups/
// (scripts/meta-rework/dump.mjs). The script refuses --apply if today's backup is missing.
import fs from "node:fs";
import { get, post } from "./_graph.mjs";

const APPLY = process.argv.includes("--apply");
const ACT = "act_20658834";
const CATALOG = "384890002574549";        // "Shopify Product Catalog" (aosom-sync meta-xml feed, hourly)
const DATASET = "214720653324969";        // web dataset used by every purchase ad set
const PAGE = "1057151924144231";          // Ameublo Direct
const IG = "17841440662705847";           // IG user already used by the live Advantage+ creative
const QUEBEC = { key: "535", name: "Quebec", country: "CA" };
const FRENCH = [9, 44];                   // same locales as every QC ad set on the account
const BACKUP = "C:/Users/vente/Documents/aosom-sync-backups/meta-2026-11-04.json";
const LOG = "C:/Users/vente/Documents/aosom-sync-backups/meta-2026-11-04-created.json";
const STAMP = "2026-11";

// Campaigns to pause (status write only). Ventes FR 52604026014005 is deliberately NOT here:
// it stays the only live ad until the owner launches its replacement.
const TO_PAUSE = {
  "52605886230405": "Ameublo Direct — Advantage+ Panier — Canada FR — 2026-10 (ADD_TO_CART)",
  "52607129544405": "Ameublo — Vendredi fou 2026 — ANNONCE TRAFIC (2–5 nov.)",
  "52605755943205": "Furnish Direct — Advantage+ Ventes — Canada hors QC — 2026-10",
  "52605886096405": "Furnish Direct — Advantage+ Panier — Canada hors QC — 2026-10",
  "52600207883205": "Retargeting — Visiteurs 60j (QC) — 2026-10",
  "52607128656205": "Ameublo — Vendredi fou 2026 — VENTES (6–30 nov.) — scheduled auto-start, non-compliant",
};

const APPROVED = "On saute le magasin. Tu sautes le prix.\n\nPas de magasin, pas de loyer, pas de vendeur à commission. Juste le produit, importé directement du fabricant, livré chez toi. Des centaines de produits en stock, livraison gratuite partout au Canada.";
const BUY2 = "Achète 2 articles : 10 % de rabais sur le moins cher des deux, appliqué automatiquement au panier. Aucun code.\n\nMeubles, rangement, patio, déco : des milliers de produits, livraison gratuite partout au Canada.";
// Vendredi fou copy, verbatim from the scheduled campaign's catalog ad (creative 1818674972755223).
const BF = "Non, ce n'est pas une erreur de prix. 😳 Jusqu'à -55 % : le Vendredi fou commence maintenant chez Ameublo Direct, 3 semaines avant le vrai Vendredi fou.\n\nLivraison gratuite au Canada (sauf certaines régions éloignées).\nPrix protégé jusqu'au 30 nov. : si le prix baisse sur notre site, on rembourse la différence sur demande (conditions sur ameublodirect.ca).";

const productSet = {
  name: `Advantage+ Ventes QC — en stock · lifestyle · sans Halloween — ${STAMP}`,
  filter: JSON.stringify({ and: [
    { availability: { eq: "in stock" } },
    { custom_label_4: { eq: "lifestyle" } },
    { product_type: { i_not_contains: "halloween" } },
  ] }),
};
const campaign = {
  name: `Ameublo Direct — Advantage+ Ventes — Québec FR — ${STAMP}`,
  objective: "OUTCOME_SALES",
  status: "PAUSED",
  special_ad_categories: [],
  buying_type: "AUCTION",
  daily_budget: "8000",                   // 80.00 CAD — Advantage+ campaign budget (owner decides)
  bid_strategy: "LOWEST_COST_WITHOUT_CAP",
};
const adSet = (campaignId, productSetId) => ({
  name: "Advantage+ · QUÉBEC · FR · catalogue en stock · ACHAT",
  campaign_id: campaignId,
  status: "PAUSED",
  optimization_goal: "OFFSITE_CONVERSIONS",
  billing_event: "IMPRESSIONS",
  destination_type: "WEBSITE",
  promoted_object: { pixel_id: DATASET, custom_event_type: "PURCHASE", product_set_id: productSetId },
  // Advantage+ audience ON; only hard controls = Quebec + French. No placement list = Advantage+ placements.
  targeting: { geo_locations: { regions: [{ key: QUEBEC.key }] }, locales: FRENCH, age_min: 18, age_max: 65, targeting_automation: { advantage_audience: 1 } },
});
const creative = (productSetId, name, bodies, utm) => ({
  name,
  product_set_id: productSetId,
  url_tags: `utm_source=facebook&utm_medium=paid&utm_campaign=${utm}`,
  object_story_spec: {
    page_id: PAGE,
    instagram_user_id: IG,
    template_data: {
      // Each catalog card/collection tile links to its own product page (catalog `link`);
      // this URL is only Meta's required fallback.
      link: "https://ameublodirect.ca/",
      message: bodies[0],
      name: "{{product.name}}",
      multi_share_end_card: false,
      show_multiple_images: true,
      call_to_action: { type: "SHOP_NOW" },
      image_overlay_spec: { overlay_template: "pill_with_text", text_type: "percentage_off", text_font: "dynads_hybrid_bold", position: "top_left", theme_color: "background_e50900_text_ffffff", float_with_margin: true },
    },
  },
  asset_feed_spec: { bodies: bodies.map((text) => ({ text })), ad_formats: ["CAROUSEL", "COLLECTION"], optimization_type: "FORMAT_AUTOMATION" },
  degrees_of_freedom_spec: { creative_features_spec: {
    adapt_to_placement: { enroll_status: "OPT_IN" },
    standard_enhancements_catalog: { enroll_status: "OPT_IN" },
  } },
});

const created = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : {};
const save = () => fs.writeFileSync(LOG, JSON.stringify(created, null, 2));

console.log(APPLY ? "=== APPLY ===" : "=== DRY-RUN (nothing sent) ===");
if (APPLY && !fs.existsSync(BACKUP)) { console.error(`backup missing: ${BACKUP}`); process.exit(1); }

// 1) Pause
for (const [id, name] of Object.entries(TO_PAUSE)) {
  console.log(`PAUSE ${id}  ${name}`);
  if (APPLY) { const r = await post(id, { status: "PAUSED" }); console.log("   ", JSON.stringify(r)); }
}

// 2) Build replacement (all PAUSED)
console.log("\nproduct_set:", JSON.stringify(productSet));
console.log("campaign:", JSON.stringify(campaign));
console.log("ad_set:", JSON.stringify(adSet("<campaign>", "<product_set>")));
if (!APPLY) process.exit(0);

if (!created.product_set_id) { created.product_set_id = (await post(`${CATALOG}/product_sets`, productSet)).id; save(); }
console.log("product_set_id", created.product_set_id);
if (!created.campaign_id) { created.campaign_id = (await post(`${ACT}/campaigns`, campaign)).id; save(); }
console.log("campaign_id", created.campaign_id);
if (!created.adset_id) { created.adset_id = (await post(`${ACT}/adsets`, adSet(created.campaign_id, created.product_set_id))).id; save(); }
console.log("adset_id", created.adset_id);

const ads = [
  ["evergreen", `Ameublo — Advantage+ Ventes QC — on saute le magasin — ${STAMP}`, [APPROVED, BUY2], "advantage_ventes_qc_2026_11", "Advantage+ — On saute le magasin (approuvé) — catalogue"],
  ["vendredi_fou", `Ameublo — Advantage+ Ventes QC — Vendredi fou — ${STAMP}`, [BF], "advantage_ventes_qc_vendredi_fou_2026", "Advantage+ — Vendredi fou (à activer le 6 nov.) — catalogue"],
];
for (const [key, crName, bodies, utm, adName] of ads) {
  if (!created[`creative_${key}`]) { created[`creative_${key}`] = (await post(`${ACT}/adcreatives`, creative(created.product_set_id, crName, bodies, utm))).id; save(); }
  if (!created[`ad_${key}`]) { created[`ad_${key}`] = (await post(`${ACT}/ads`, { name: adName, adset_id: created.adset_id, status: "PAUSED", creative: { creative_id: created[`creative_${key}`] } })).id; save(); }
  console.log(key, "creative", created[`creative_${key}`], "ad", created[`ad_${key}`]);
}

// 3) Read back
const c = await get(created.campaign_id, { fields: "name,status,effective_status,objective,daily_budget,advantage_state_info" });
const s = await get(created.adset_id, { fields: "status,effective_status,optimization_goal,promoted_object,targeting,existing_customer_budget_percentage" });
const ps = await get(created.product_set_id, { fields: "name,product_count,filter" });
created.readback = { campaign: c, adset: s, product_set: ps };
save();
console.log(JSON.stringify(created.readback, null, 2));
