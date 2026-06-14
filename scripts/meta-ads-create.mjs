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
    // The old ad set 52556997397005 is locked to a personal catalog (promoted_object is
    // immutable — Meta rejects re-point, subcode 1885090). So create a NEW ad set under the
    // SAME campaign, cloning its Canada-FR retargeting targeting, with the Business catalog.
    adsetId: null,                        // null → create a new ad set (see sourceAdsetId)
    campaignId: "52556997335005",         // reuse existing OUTCOME_TRAFFIC campaign
    sourceAdsetId: "52556997397005",      // clone targeting + optimization/billing from here
    dailyBudget: 2000,                    // $20/day in cents — unchanged
    catalogId: "384890002574549",         // Business "Shopify Product Catalog" (ads-eligible)
    productSetId: "2891699814486850",     // "Store collection · All Products" (1069, Business catalog)
    newAdsetName: "Retargeting — Visiteurs 30j (Business)",
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

  // Build the ad set to target. When cfg.adsetId is null we create a NEW ad set under the
  // existing campaign, cloning the source ad set's targeting/optimization but with the Business
  // catalog + product set (the old ad set's catalog is immutable, so re-point is impossible).
  let newAdsetPayload = null;
  if (!cfg.adsetId && !cfg.sourceAdsetId) {
    // No existing ad set AND nothing to clone (e.g. EN: campaign + ad set don't exist yet) →
    // dry-run only; show the structure to create, refuse --apply.
    if (APPLY) die(`Profil ${PROFILE}: la campagne/ad set "${cfg.campaignName}" n'existe pas encore — créer la campagne + ad set d'abord (dry-run uniquement ici).`);
    console.log(`\n${line}\nÀ CRÉER D'ABORD — Campaign + Ad set (n'existent pas encore)\n${line}`);
    console.log(JSON.stringify({
      campaign: { name: cfg.campaignName, objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [] },
      adset: {
        name: "Retargeting — Visitors 30d", daily_budget: cfg.dailyBudget || 2000, status: "PAUSED",
        optimization_goal: "LANDING_PAGE_VIEWS", billing_event: "IMPRESSIONS",
        promoted_object: { product_catalog_id: cfg.catalogId, product_set_id: cfg.productSetId },
        targeting: "<audience retargeting visiteurs 30j — créer/choisir pour EN>",
      },
    }, null, 2));
  } else if (!cfg.adsetId) {
    const src = await get(cfg.sourceAdsetId, { fields: "id,name,campaign_id,daily_budget,status,optimization_goal,billing_event,bid_strategy,bid_amount,targeting" });
    console.log(`\nAd set source (clonage targeting) : ${src.id} "${src.name}" — opt=${src.optimization_goal} billing=${src.billing_event} bid=${src.bid_strategy}${src.bid_amount ? `/${src.bid_amount}` : ""} budget=${src.daily_budget}`);
    if (cfg.campaignId && src.campaign_id !== cfg.campaignId) die(`Ad set source ${cfg.sourceAdsetId} appartient à ${src.campaign_id}, pas ${cfg.campaignId}`);
    newAdsetPayload = {
      name: cfg.newAdsetName,
      campaign_id: cfg.campaignId,
      daily_budget: cfg.dailyBudget,
      billing_event: src.billing_event,
      optimization_goal: src.optimization_goal,
      // Clone the bid strategy explicitly — without it Meta infers one that requires a
      // bid_amount and rejects the create (subcode 2490487). LOWEST_COST_WITHOUT_CAP needs none.
      bid_strategy: src.bid_strategy,
      ...(src.bid_amount ? { bid_amount: src.bid_amount } : {}),
      promoted_object: { product_catalog_id: cfg.catalogId, product_set_id: cfg.productSetId },
      targeting: src.targeting,           // same Canada-FR retargeting audience as the source
      status: "PAUSED",
    };
    console.log(`\n${line}\nÉTAPE 1 — POST ${ACT}/adsets  (NOUVEL ad set, catalogue Business, PAUSED)\n${line}`);
    console.log(JSON.stringify(newAdsetPayload, null, 2));
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
  console.log(JSON.stringify(adPayload("{id_du_créatif}", cfg.adsetId || "{nouvel ad set — étape 1}"), null, 2));

  if (!APPLY) {
    console.log(`\n${line}\nDRY-RUN terminé — rien n'a été envoyé. Relancer avec --apply pour créer (ad set + créatif + ad, tous PAUSED).\n${line}`);
    return;
  }

  // ── ÉTAPE 1 (apply): create the new ad set if we're not attaching to an existing one ──
  let targetAdsetId = cfg.adsetId;
  if (!targetAdsetId) {
    if (!newAdsetPayload) die("Aucun ad set existant et aucun payload de nouvel ad set — impossible de créer l'ad.");
    const createdAdset = await post(`${ACT}/adsets`, newAdsetPayload);
    targetAdsetId = createdAdset.id;
    console.log(`\n[ok] Ad set créé (PAUSED) : ${targetAdsetId}`);
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
    const ad = await post(`${ACT}/ads`, adPayload(creativeId, targetAdsetId));
    console.log(`[ok] Ad créée (PAUSED) : ${ad.id}`);
  }
  console.log(`\n${line}\nTerminé. La campagne reste PAUSED — activer manuellement dans Ads Manager.\n${line}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
