// Meta Dynamic Ads — create the Ad Creative + Ad for the (PAUSED) retargeting
// campaign so it becomes operational. The campaign + ad set + catalog + audience
// already exist; only the creative and the ad are missing.
//
// SAFE BY DEFAULT: running this with no flag is a DRY-RUN — it lists the current
// state and prints the exact payloads it WOULD POST, but sends nothing. Pass
// --apply to actually create the creative + ad (both created PAUSED).
//
//   node scripts/meta-ads-create.mjs            # dry-run (default) — prints payloads
//   node scripts/meta-ads-create.mjs --apply    # create creative + ad (PAUSED)
//
// On Windows ARM run under x64 node (global fetch): see CLAUDE.md / dev.ps1.
//
// Idempotent: --apply reuses an existing creative with the same name and skips
// ad creation if an ad with the same name already exists on the target ad set,
// so a re-run can't create duplicates.
import { loadEnv } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const API = "https://graph.facebook.com/v21.0";
const TOKEN = loadEnv().META_ACCESS_TOKEN;

// ── Fixed IDs for this campaign (provided/verified 2026-06-14) ──────────────
const ACT = "act_20658834";                     // ad account
const PAGE_ID = "1057151924144231";             // Ameublo Direct FB page
const ADSET_ID = "52556997397005";              // "Retargeting ? Visiteurs 30j" ($20/day, PAUSED)
const CAMPAIGN_ID = "52556997335005";           // OUTCOME_TRAFFIC
const CATALOG_ID = "1103064966519153";          // product catalog
const PRODUCT_SET_ID = "1718195966267686";      // "All Products"

const CREATIVE_NAME = "Ameublo Direct — Catalogue Dynamic";
const AD_NAME = "Dynamic Ad — Visiteurs 30j";

const line = "=".repeat(72);
const die = (msg) => { console.error(`\nERREUR: ${msg}`); process.exit(1); };
if (!TOKEN) die("META_ACCESS_TOKEN absent de .env.local");

async function get(path, params = {}) {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) die(`GET ${path} → ${res.status} ${JSON.stringify(json.error || json)}`);
  return json;
}

async function post(path, fields) {
  const body = new URLSearchParams();
  body.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(fields)) {
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`${API}/${path}`, { method: "POST", body });
  const json = await res.json();
  if (!res.ok) die(`POST ${path} → ${res.status} ${JSON.stringify(json.error || json)}`);
  return json;
}

// ── The exact payloads (Graph API form-encodes nested objects as JSON) ──────
const creativePayload = {
  name: CREATIVE_NAME,
  object_story_spec: {
    page_id: PAGE_ID,
    template_data: {
      call_to_action: { type: "SHOP_NOW" },
      link: "https://ameublodirect.ca",
      message: "Découvrez notre sélection de meubles et mobilier d'extérieur. Livraison gratuite au Canada.",
      name: "Ameublo Direct",
      description: "Plus de 490 produits disponibles",
    },
  },
  product_set_id: PRODUCT_SET_ID,
};

const adPayload = (creativeId) => ({
  name: AD_NAME,
  adset_id: ADSET_ID,
  creative: { creative_id: creativeId },
  status: "PAUSED",
});

async function main() {
  console.log(`${line}\nMETA DYNAMIC ADS — ${APPLY ? "APPLY (création réelle)" : "DRY-RUN (aucun envoi)"}\n${line}`);

  // ── ÉTAPE 1: état actuel (lecture seule) ──────────────────────────────────
  const adset = await get(ADSET_ID, { fields: "id,name,campaign_id,daily_budget,status,promoted_object,optimization_goal" });
  const pset = await get(PRODUCT_SET_ID, { fields: "id,name,product_count,product_catalog{id,name}" });
  console.log("\nAd set cible :", JSON.stringify(adset));
  console.log("Product set  :", JSON.stringify(pset));
  if (adset.campaign_id !== CAMPAIGN_ID) die(`Ad set ${ADSET_ID} appartient à ${adset.campaign_id}, pas ${CAMPAIGN_ID}`);

  const creatives = (await get(`${ACT}/adcreatives`, { fields: "id,name", limit: "200" })).data || [];
  const ads = (await get(`${ACT}/ads`, { fields: "id,name,status,adset_id", limit: "200" })).data || [];
  const existingCreative = creatives.find((c) => c.name === CREATIVE_NAME);
  const existingAd = ads.find((a) => a.name === AD_NAME && a.adset_id === ADSET_ID);
  console.log(`\nCréatif "${CREATIVE_NAME}" déjà présent : ${existingCreative ? existingCreative.id : "non"}`);
  console.log(`Ad "${AD_NAME}" déjà présente sur l'ad set : ${existingAd ? existingAd.id : "non"}`);

  // ── ÉTAPE 2 + 3: payloads ─────────────────────────────────────────────────
  console.log(`\n${line}\nÉTAPE 2 — POST ${ACT}/adcreatives\n${line}`);
  console.log(JSON.stringify(creativePayload, null, 2));
  console.log(`\n${line}\nÉTAPE 3 — POST ${ACT}/ads  (creative_id rempli après l'étape 2)\n${line}`);
  console.log(JSON.stringify(adPayload("{id_du_créatif}"), null, 2));

  if (!APPLY) {
    console.log(`\n${line}\nDRY-RUN terminé — rien n'a été envoyé. Relancer avec --apply pour créer (en PAUSED).\n${line}`);
    return;
  }

  // ── ÉTAPE 2: create (or reuse) the creative ───────────────────────────────
  let creativeId;
  if (existingCreative) {
    creativeId = existingCreative.id;
    console.log(`\n[skip] Créatif déjà présent → réutilisation de ${creativeId}`);
  } else {
    const created = await post(`${ACT}/adcreatives`, creativePayload);
    creativeId = created.id;
    console.log(`\n[ok] Créatif créé : ${creativeId}`);
  }

  // ── ÉTAPE 3: create the ad (PAUSED) ───────────────────────────────────────
  if (existingAd) {
    console.log(`[skip] Ad déjà présente sur l'ad set → ${existingAd.id} (aucune création)`);
  } else {
    const ad = await post(`${ACT}/ads`, adPayload(creativeId));
    console.log(`[ok] Ad créée (PAUSED) : ${ad.id}`);
  }
  console.log(`\n${line}\nTerminé. La campagne reste PAUSED — activer manuellement dans Ads Manager.\n${line}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
