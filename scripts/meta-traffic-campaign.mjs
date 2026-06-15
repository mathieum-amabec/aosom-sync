// Meta — create a broad TRAFFIC campaign (campaign + ad set + creative + ad) that
// drives link clicks to ameublodirect.ca with a dynamic single-image creative pulled
// from the Business catalog. Everything is created PAUSED — nothing spends.
//
// SAFE BY DEFAULT: no flag = DRY-RUN (verifies the catalog + prints the 4 payloads it
// WOULD POST, sends nothing). --apply creates campaign → ad set → creative → ad (PAUSED),
// idempotent by name (reuses anything already created so a re-run can't duplicate).
//
//   node scripts/meta-traffic-campaign.mjs            # dry-run (default)
//   node scripts/meta-traffic-campaign.mjs --apply     # create the campaign (PAUSED)
//
// On Windows ARM run under x64 node (global fetch): see CLAUDE.md / dev.ps1.
//
// OBJECTIVE NOTE: the spec says "LINK_CLICKS". On this ODAX account the *campaign*
// objective for traffic is OUTCOME_TRAFFIC (its existing traffic campaign 52556997335005
// uses it; Meta rejects the legacy LINK_CLICKS as a campaign objective). The "link clicks"
// intent is carried by the ad set's optimization_goal = LINK_CLICKS.
import { loadEnv } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const API = "https://graph.facebook.com/v21.0";
const TOKEN = loadEnv().META_ACCESS_TOKEN;
const ACT = "act_20658834";

// ── Spec ────────────────────────────────────────────────────────────────────
const PAGE_ID = "1057151924144231";          // Ameublo Direct FB page
const CATALOG_ID = "384890002574549";         // Business "Shopify Product Catalog" (ads-eligible)
const PRODUCT_SET_ID = "2891699814486850";    // "Store collection All Products" (in that catalog)
const LINK = "https://ameublodirect.ca";

const CAMPAIGN_NAME = "Trafic — Canada FR/EN";
const ADSET_NAME = "Trafic — Canada FR/EN — Broad";
const CREATIVE_NAME = "Trafic — Catalogue Dynamic — Creative";
const AD_NAME = "Trafic — Catalogue Dynamic";

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

// ── Payloads ────────────────────────────────────────────────────────────────
const campaignPayload = {
  name: CAMPAIGN_NAME,
  objective: "OUTCOME_TRAFFIC",     // ODAX traffic objective (= "LINK_CLICKS" intent; see header)
  status: "PAUSED",
  special_ad_categories: [],
};

const adsetPayload = (campaignId) => ({
  name: ADSET_NAME,
  campaign_id: campaignId,
  daily_budget: 500,                // $5/day (minor units / cents)
  billing_event: "IMPRESSIONS",
  optimization_goal: "LINK_CLICKS", // optimize for link clicks (traffic)
  status: "PAUSED",
  // Catalog ad: the ad set advertises the Business catalog; the creative below pulls
  // its image from PRODUCT_SET_ID in this catalog.
  promoted_object: { product_catalog_id: CATALOG_ID },
  targeting: {
    geo_locations: { countries: ["CA"] },
    age_min: 25,
    age_max: 65,
    // Broad: NO interests. Let Meta optimize the audience (Advantage+ audience).
    targeting_automation: { advantage_audience: 1 },
    // Automatic placements (Advantage+ placements): omit publisher_platforms so Meta
    // uses all eligible placements.
  },
});

// Bilingual single-image dynamic creative. FR + EN titles/descriptions go in an
// asset_feed_spec so Meta can show the right language / optimize; the image is pulled
// dynamically from the catalog product set. CTA SHOP_NOW → LINK.
const creativePayload = {
  name: CREATIVE_NAME,
  object_story_spec: { page_id: PAGE_ID },
  product_set_id: PRODUCT_SET_ID,
  asset_feed_spec: {
    ad_formats: ["SINGLE_IMAGE"],
    titles: [
      { text: "Meublez votre espace à votre image" }, // FR
      { text: "Furnish your space, your way" },        // EN
    ],
    descriptions: [
      { text: "Livraison gratuite partout au Canada" }, // FR
      { text: "Free shipping across Canada" },           // EN
    ],
    link_urls: [{ website_url: LINK }],
    call_to_action_types: ["SHOP_NOW"],
  },
};

const adPayload = (creativeId, adsetId) => ({
  name: AD_NAME,
  adset_id: adsetId,
  creative: { creative_id: creativeId },
  status: "PAUSED",
});

async function catalogIsAdsEligible(catalogId) {
  const cat = await get(catalogId, { fields: "id,name,product_count,business{id,name}" });
  return { eligible: Boolean(cat.business), cat };
}

// Find an existing object by exact name under the account edge (idempotency).
async function findByName(edge, name) {
  const rows = (await get(`${ACT}/${edge}`, { fields: "id,name", limit: "500" })).data || [];
  return rows.find((r) => r.name === name) || null;
}

async function main() {
  console.log(`${line}\nMETA TRAFFIC CAMPAIGN — ${APPLY ? "APPLY (création réelle)" : "DRY-RUN (aucun envoi)"}\n${line}`);

  // Preflight: the catalog must be a Business (ads-eligible) catalog.
  const { eligible, cat } = await catalogIsAdsEligible(CATALOG_ID);
  console.log(`\nCatalogue ${CATALOG_ID}: "${cat.name}" — ${cat.product_count} produits — ads-eligible: ${eligible ? "OUI" : "NON"}`);
  if (!eligible) {
    console.log("\n⚠ Ce catalogue n'est pas Business/ads-eligible — voir docs/META-ADS-SETUP.md.");
    if (APPLY) die("Catalogue non ads-eligible — corriger d'abord.");
  }

  // Current state (idempotency check)
  const [exCampaign, exAdset, exCreative, exAd] = await Promise.all([
    findByName("campaigns", CAMPAIGN_NAME),
    findByName("adsets", ADSET_NAME),
    findByName("adcreatives", CREATIVE_NAME),
    findByName("ads", AD_NAME),
  ]);
  console.log(`\nDéjà présent — campaign: ${exCampaign?.id || "non"} | ad set: ${exAdset?.id || "non"} | creative: ${exCreative?.id || "non"} | ad: ${exAd?.id || "non"}`);

  // Print the 4 payloads
  console.log(`\n${line}\nÉTAPE 1 — POST ${ACT}/campaigns\n${line}`);
  console.log(JSON.stringify(campaignPayload, null, 2));
  console.log("→ NOTE: objectif OUTCOME_TRAFFIC (mappe \"LINK_CLICKS\"; voir en-tête du script).");
  console.log(`\n${line}\nÉTAPE 2 — POST ${ACT}/adsets  (campaign_id rempli après l'étape 1)\n${line}`);
  console.log(JSON.stringify(adsetPayload("{campaign_id}"), null, 2));
  console.log(`\n${line}\nÉTAPE 3 — POST ${ACT}/adcreatives\n${line}`);
  console.log(JSON.stringify(creativePayload, null, 2));
  console.log(`\n${line}\nÉTAPE 4 — POST ${ACT}/ads  (creative_id + adset_id remplis après 2 & 3)\n${line}`);
  console.log(JSON.stringify(adPayload("{creative_id}", "{adset_id}"), null, 2));

  if (!APPLY) {
    console.log(`\n${line}\nDRY-RUN terminé — rien n'a été envoyé. Relancer avec --apply pour créer (en PAUSED).\n${line}`);
    return;
  }

  // ── Apply: create (or reuse) each object in order ──────────────────────────
  const campaignId = exCampaign?.id || (await post(`${ACT}/campaigns`, campaignPayload)).id;
  console.log(`\n[${exCampaign ? "skip" : "ok"}] Campaign: ${campaignId}`);

  const adsetId = exAdset?.id || (await post(`${ACT}/adsets`, adsetPayload(campaignId))).id;
  console.log(`[${exAdset ? "skip" : "ok"}] Ad set: ${adsetId}`);

  const creativeId = exCreative?.id || (await post(`${ACT}/adcreatives`, creativePayload)).id;
  console.log(`[${exCreative ? "skip" : "ok"}] Creative: ${creativeId}`);

  if (exAd) {
    console.log(`[skip] Ad déjà présente: ${exAd.id}`);
  } else {
    const ad = await post(`${ACT}/ads`, adPayload(creativeId, adsetId));
    console.log(`[ok] Ad (PAUSED): ${ad.id}`);
  }
  console.log(`\n${line}\nTerminé. Tout est PAUSED — activer manuellement dans Ads Manager.\n${line}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
