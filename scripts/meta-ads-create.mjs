// Meta Dynamic Ads — create the Ad Creative + Ad for the (PAUSED) retargeting
// campaigns so they become operational. The FR campaign + ad set + catalog +
// audience already exist; only the creative and the ad are missing. The EN
// (Furnish Direct) campaign does not exist yet — its ad set/campaign must be
// created first, so EN is dry-run only here.
//
// SAFE BY DEFAULT: no flag = DRY-RUN (lists state, prints the payloads it WOULD
// POST, sends nothing). --apply actually creates the creative + ad (both PAUSED).
//
//   node scripts/meta-ads-create.mjs                 # FR dry-run (default)
//   node scripts/meta-ads-create.mjs --apply         # FR: create creative + ad (PAUSED)
//   node scripts/meta-ads-create.mjs --profile en    # EN dry-run (Furnish Direct)
//
// On Windows ARM run under x64 node (global fetch): see CLAUDE.md / dev.ps1.
//
// CATALOG BLOCKER (2026-06-14): the FR ad set points at catalog 1103064966519153
// ("Products for Mathieu personal catalog"), a *personal* Marketplace catalog,
// which Meta forbids for running ads (error code 10 / subcode 3379015). Ads can
// only run against a *Business* catalog. The Shopify Business Manager
// (business 853563322151547) owns "Shopify Product Catalog" (384890002574549) —
// ads-eligible, but only 5 products synced so far. Fix before --apply will work:
//   1. Complete the Shopify -> Meta catalog sync into 384890002574549.
//   2. Re-point the ad set's promoted_object.product_catalog_id (and product_set)
//      to that Business catalog.
// See docs/META-ADS-SETUP.md for the full remediation.
import { loadEnv } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const PROFILE = (process.argv.find((a) => a.startsWith("--profile="))?.split("=")[1])
  || (process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : "fr");
const API = "https://graph.facebook.com/v21.0";
const TOKEN = loadEnv().META_ACCESS_TOKEN;
const ACT = "act_20658834";

// ── Per-brand config ────────────────────────────────────────────────────────
const PROFILES = {
  fr: {
    label: "Ameublo Direct (FR)",
    pageId: "1057151924144231",
    adsetId: "52556997397005",            // exists: "Retargeting ? Visiteurs 30j" ($20/day, PAUSED)
    campaignId: "52556997335005",         // exists: OUTCOME_TRAFFIC
    catalogId: "1103064966519153",        // personal catalog — BLOCKED for ads (see header)
    productSetId: "1718195966267686",     // "All Products"
    creativeName: "Ameublo Direct — Catalogue Dynamic",
    adName: "Dynamic Ad — Visiteurs 30j",
    creative: {
      callToAction: "SHOP_NOW",
      link: "https://ameublodirect.ca",
      message: "Découvrez notre sélection de meubles et mobilier d'extérieur. Livraison gratuite au Canada.",
      name: "Ameublo Direct",
      description: "Plus de 490 produits disponibles",
    },
  },
  en: {
    label: "Furnish Direct (EN)",
    pageId: "1080288908505354",
    adsetId: null,                        // does NOT exist yet — create campaign + ad set first
    campaignId: null,
    campaignName: "Furnish Direct — Retargeting EN",
    catalogId: "1103064966519153",        // same catalog → same blocker; use the Business catalog once synced
    productSetId: "1718195966267686",
    creativeName: "Furnish Direct — Catalog Dynamic",
    adName: "Dynamic Ad — Visitors 30d",
    creative: {
      callToAction: "SHOP_NOW",
      // furnishdirect.ca once DNS is ready; for now the /en/ locale on the live domain.
      link: "https://ameublodirect.ca/en/",
      message: "Discover our selection of furniture and outdoor living. Free shipping across Canada.",
      name: "Furnish Direct",
      description: "Over 490 products available",
    },
  },
};

const line = "=".repeat(72);
const die = (msg) => { console.error(`\nERREUR: ${msg}`); process.exit(1); };
if (!TOKEN) die("META_ACCESS_TOKEN absent de .env.local");
const cfg = PROFILES[PROFILE];
if (!cfg) die(`Profil inconnu: "${PROFILE}" (attendu: fr | en)`);

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

const creativePayload = {
  name: cfg.creativeName,
  object_story_spec: {
    page_id: cfg.pageId,
    template_data: {
      call_to_action: { type: cfg.creative.callToAction },
      link: cfg.creative.link,
      message: cfg.creative.message,
      name: cfg.creative.name,
      description: cfg.creative.description,
    },
  },
  product_set_id: cfg.productSetId,
};

const adPayload = (creativeId, adsetId) => ({
  name: cfg.adName,
  adset_id: adsetId,
  creative: { creative_id: creativeId },
  status: "PAUSED",
});

// Returns true when the catalog is a Business catalog (ads-eligible). A personal
// Marketplace catalog has no `business` owner and cannot run ads.
async function catalogIsAdsEligible(catalogId) {
  const cat = await get(catalogId, { fields: "id,name,product_count,business{id,name}" });
  return { eligible: Boolean(cat.business), cat };
}

async function main() {
  console.log(`${line}\nMETA DYNAMIC ADS — ${cfg.label} — ${APPLY ? "APPLY (création réelle)" : "DRY-RUN (aucun envoi)"}\n${line}`);

  // Catalog eligibility preflight — fail fast with remediation instead of a raw 400.
  const { eligible, cat } = await catalogIsAdsEligible(cfg.catalogId);
  console.log(`\nCatalogue ${cfg.catalogId}: "${cat.name}" — ${cat.product_count} produits — ads-eligible: ${eligible ? "OUI" : "NON (catalogue personnel)"}`);
  if (!eligible) {
    console.log(
      `\n⚠ BLOCAGE: ce catalogue est un catalogue personnel/Marketplace que Meta interdit pour les pubs.\n` +
      `  Utiliser un catalogue Business (ex. 384890002574549 "Shopify Product Catalog" du Business 853563322151547,\n` +
      `  une fois la sync Shopify complète) et re-pointer promoted_object du ad set. Voir docs/META-ADS-SETUP.md.`
    );
    if (APPLY) die("Création impossible tant que le ad set pointe un catalogue personnel. Corriger le catalogue d'abord.");
  }

  // EN: campaign/ad set don't exist yet → dry-run only (show the full structure to create).
  if (!cfg.adsetId) {
    if (APPLY) die(`Profil ${PROFILE}: la campagne/ad set "${cfg.campaignName}" n'existe pas encore — créer la campagne + ad set d'abord (dry-run uniquement ici).`);
    console.log(`\n${line}\nÀ CRÉER D'ABORD — Campaign + Ad set (n'existent pas encore)\n${line}`);
    console.log(JSON.stringify({
      campaign: { name: cfg.campaignName, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [] },
      adset: {
        name: "Retargeting — Visitors 30d", daily_budget: 2000, status: "PAUSED",
        optimization_goal: "LANDING_PAGE_VIEWS", billing_event: "IMPRESSIONS",
        promoted_object: { product_catalog_id: "<catalogue Business ads-eligible>" },
        targeting: "<audience retargeting visiteurs 30j — ex. 52556992755405 ou équivalent EN>",
      },
    }, null, 2));
  } else {
    const adset = await get(cfg.adsetId, { fields: "id,name,campaign_id,daily_budget,status,promoted_object,optimization_goal" });
    console.log("\nAd set cible :", JSON.stringify(adset));
    if (cfg.campaignId && adset.campaign_id !== cfg.campaignId) die(`Ad set ${cfg.adsetId} appartient à ${adset.campaign_id}, pas ${cfg.campaignId}`);
  }

  const creatives = (await get(`${ACT}/adcreatives`, { fields: "id,name", limit: "200" })).data || [];
  const ads = (await get(`${ACT}/ads`, { fields: "id,name,status,adset_id", limit: "200" })).data || [];
  const existingCreative = creatives.find((c) => c.name === cfg.creativeName);
  const existingAd = ads.find((a) => a.name === cfg.adName && (!cfg.adsetId || a.adset_id === cfg.adsetId));
  console.log(`\nCréatif "${cfg.creativeName}" déjà présent : ${existingCreative ? existingCreative.id : "non"}`);
  console.log(`Ad "${cfg.adName}" déjà présente : ${existingAd ? existingAd.id : "non"}`);

  console.log(`\n${line}\nÉTAPE 2 — POST ${ACT}/adcreatives\n${line}`);
  console.log(JSON.stringify(creativePayload, null, 2));
  console.log(`\n${line}\nÉTAPE 3 — POST ${ACT}/ads  (creative_id rempli après l'étape 2)\n${line}`);
  console.log(JSON.stringify(adPayload("{id_du_créatif}", cfg.adsetId || "{id_du_ad_set}"), null, 2));

  if (!APPLY) {
    console.log(`\n${line}\nDRY-RUN terminé — rien n'a été envoyé.${cfg.adsetId ? " Relancer avec --apply pour créer (en PAUSED)." : ""}\n${line}`);
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
    console.log(`[skip] Ad déjà présente → ${existingAd.id} (aucune création)`);
  } else {
    const ad = await post(`${ACT}/ads`, adPayload(creativeId, cfg.adsetId));
    console.log(`[ok] Ad créée (PAUSED) : ${ad.id}`);
  }
  console.log(`\n${line}\nTerminé. La campagne reste PAUSED — activer manuellement dans Ads Manager.\n${line}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
