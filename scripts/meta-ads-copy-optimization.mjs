// Meta — replace the creative on the traffic ad set with a multi-copy DYNAMIC
// (catalogue) creative: asset_feed_spec carries 5 primary texts × 5 headlines × 2
// descriptions, ad_formats AUTOMATIC_FORMAT, and product_set_id so Meta pulls the
// product images from the catalogue automatically and tests the copy/headline matrix
// per user. CTA SHOP_NOW → ameublodirect.ca.
//
// SAFE BY DEFAULT: no flag = DRY-RUN (prints the full asset_feed_spec payload + the existing
// ad it WOULD delete, sends nothing). --apply creates the new creative + ad (PAUSED) FIRST,
// then deletes the old ad — so a creative failure can never strand the ad set with zero ads.
//
//   node scripts/meta-ads-copy-optimization.mjs            # dry-run (default)
//   node scripts/meta-ads-copy-optimization.mjs --apply    # delete old ad + create new (PAUSED)
//
// On Windows ARM run under x64 node (global fetch): see CLAUDE.md / dev.ps1.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const API = "https://graph.facebook.com/v21.0";
const TOKEN = loadEnv().META_ACCESS_TOKEN;
const ACT = "act_20658834";

// ── Spec (this evening's traffic campaign) ───────────────────────────────────
const CAMPAIGN_ID = "52562992827605";  // traffic campaign created this evening (reference)
const ADSET_ID = "52562995963805";     // traffic ad set — the creative target
const PAGE_ID = "1057151924144231";    // Ameublo Direct FB page
const PRODUCT_SET_ID = "2891699814486850";  // catalogue product set — Meta pulls images dynamically
const LINK = "https://ameublodirect.ca";
const CREATIVE_NAME = "Trafic — Multi-copy Advantage+ FR";
const AD_NAME = "Trafic — Multi-copy Advantage+ FR";

const PRIMARY_TEXTS = [
  "Livraison gratuite partout au Canada 🇨🇦 Découvrez des meubles et accessoires livrés directement à votre porte — sans frais cachés.",
  "Des milliers de Québécois ont déjà meublé leur espace avec Ameublo Direct. Votre prochain coup de cœur est à un clic.",
  "Mobilier extérieur, meubles pour enfants, accessoires maison — tout ce dont vous avez besoin, livré rapidement au Canada.",
  "Pourquoi payer plus cher en magasin? Trouvez les mêmes produits de qualité, livrés chez vous, sans vous déplacer.",
  "Nouvelle collection disponible. Meublez votre intérieur et votre extérieur avec style — livraison gratuite incluse 🚚",
];
const HEADLINES = [
  "Livraison gratuite au Canada",
  "Qualité · Style · Livraison rapide",
  "Votre maison, votre style",
  "Des meubles livrés chez vous",
  "Découvrez notre collection",
];
const DESCRIPTIONS = [
  "Ameublo Direct — Des centaines de produits sélectionnés pour votre maison",
  "Mobilier et accessoires — Livraison gratuite partout au Canada 🇨🇦",
];

const line = "=".repeat(72);
const die = (msg) => { console.error(`\nERREUR: ${msg}`); process.exit(1); };
// Token / OAuth failures (Graph error #190) are a STOP-and-tell-Mat condition, not a retry.
function dieOnError(path, json, status) {
  const e = json.error || {};
  if (e.code === 190 || /access token|oauth|session has expired/i.test(e.message || "")) {
    die(`⛔ TOKEN META INVALIDE/EXPIRÉ (Graph #${e.code || "190"}) sur ${path}: ${e.message || ""}\n   → STOP. Préviens Mat : régénérer META_ACCESS_TOKEN (Business system-user) et mettre à jour .env.local + Vercel.`);
  }
  die(`${path} → ${status} ${JSON.stringify(e.message ? e : json)}`);
}
if (!TOKEN) die("META_ACCESS_TOKEN absent de .env.local");

async function get(path, params = {}) {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) dieOnError(`GET ${path}`, json, res.status);
  return json;
}
async function post(path, fields) {
  const body = new URLSearchParams();
  body.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(fields)) body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  const res = await fetch(`${API}/${path}`, { method: "POST", body });
  const json = await res.json();
  if (!res.ok) dieOnError(`POST ${path}`, json, res.status);
  return json;
}
async function del(path) {
  const res = await fetch(`${API}/${path}?access_token=${encodeURIComponent(TOKEN)}`, { method: "DELETE" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) dieOnError(`DELETE ${path}`, json, res.status);
  return json;
}

// ── asset_feed_spec (multi-copy Advantage+) ──────────────────────────────────
const assetFeedSpec = {
  bodies: PRIMARY_TEXTS.map((text) => ({ text })),
  titles: HEADLINES.map((text) => ({ text })),
  descriptions: DESCRIPTIONS.map((text) => ({ text })),
  call_to_action_types: ["SHOP_NOW"],
  link_urls: [{ website_url: LINK }],
  ad_formats: ["AUTOMATIC_FORMAT"],
};
// Dynamic (catalogue) creative: product_set_id supplies the images, so no image_hash
// is required. asset_feed_spec still drives the 5×5×2 copy/headline/description matrix.
const creativePayload = {
  name: CREATIVE_NAME,
  object_story_spec: { page_id: PAGE_ID },
  product_set_id: PRODUCT_SET_ID,
  asset_feed_spec: assetFeedSpec,
};
const adPayload = (creativeId) => ({
  name: AD_NAME,
  adset_id: ADSET_ID,
  creative: { creative_id: creativeId },
  status: "PAUSED",
});

async function main() {
  console.log(`${line}\nMETA MULTI-COPY ADVANTAGE+ (FR) — ${APPLY ? "APPLY (création réelle)" : "DRY-RUN (aucun envoi)"}\n${line}`);
  console.log(`Campagne ${CAMPAIGN_ID} · Ad set ${ADSET_ID} · Page ${PAGE_ID}`);

  // Existing ad(s) on the target ad set — the creative we'd replace.
  const ads = (await get(`${ACT}/ads`, { fields: "id,name,status,adset_id,creative", limit: "200" })).data || [];
  const onAdset = ads.filter((a) => String(a.adset_id) === ADSET_ID);
  console.log(`\nAds déjà sur l'ad set ${ADSET_ID}: ${onAdset.length ? onAdset.map((a) => `${a.id} ("${a.name}", ${a.status})`).join(", ") : "aucune"}`);
  if (onAdset.length) console.log(`→ ${APPLY ? "seront SUPPRIMÉES" : "seraient supprimées (--apply)"} APRÈS la création de la nouvelle ad (create-before-delete).`);

  // Count assertion — the whole point is the multi-copy matrix.
  console.log(`\n${line}\nasset_feed_spec — counts: bodies=${assetFeedSpec.bodies.length}/5, titles=${assetFeedSpec.titles.length}/5, descriptions=${assetFeedSpec.descriptions.length}/2\n${line}`);
  if (assetFeedSpec.bodies.length !== 5 || assetFeedSpec.titles.length !== 5 || assetFeedSpec.descriptions.length !== 2) {
    die(`Counts inattendus (attendu 5/5/2) — vérifier PRIMARY_TEXTS / HEADLINES / DESCRIPTIONS.`);
  }

  console.log(`\n${line}\nÉTAPE 1 — POST ${ACT}/adcreatives  (payload complet)\n${line}`);
  console.log(JSON.stringify(creativePayload, null, 2));
  console.log(`\n${line}\nÉTAPE 2 — POST ${ACT}/ads  (creative_id rempli après l'étape 1)\n${line}`);
  console.log(JSON.stringify(adPayload("{creative_id}"), null, 2));

  console.log(`\n✓ NOTE: creative DYNAMIQUE — ad_formats AUTOMATIC_FORMAT + product_set_id ${PRODUCT_SET_ID}.
  Meta tire les images du catalogue automatiquement (aucun image_hash requis) et teste la
  matrice 5 bodies × 5 titles × 2 descriptions. Ordre --apply : créer AVANT de supprimer.`);

  if (!APPLY) {
    console.log(`\n${line}\nDRY-RUN terminé — rien n'a été envoyé. Relancer avec --apply (crée en PAUSED).\n${line}`);
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  // Create the new creative + ad (PAUSED) FIRST. Only once the replacement exists do we
  // delete the old ad(s) — so a failure here can never leave the ad set with zero ads.
  const creativeId = (await post(`${ACT}/adcreatives`, creativePayload)).id;
  console.log(`[ok] Creative créé: ${creativeId}`);
  const ad = await post(`${ACT}/ads`, adPayload(creativeId));
  console.log(`[ok] Ad créée (PAUSED): ${ad.id}`);
  for (const a of onAdset) {
    await del(a.id);
    console.log(`[ok] Ancienne ad supprimée: ${a.id} ("${a.name}")`);
  }

  // Log the created Ad ID to the ops doc.
  const docPath = join(__dirname, "..", "docs", "META-ADS-SETUP.md");
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    const entry = `\n- ${stamp} — Multi-copy Advantage+ FR creative ${creativeId} + ad **${ad.id}** (PAUSED) on ad set ${ADSET_ID} (campaign ${CAMPAIGN_ID}). 5 bodies × 5 titles × 2 descriptions.\n`;
    appendFileSync(docPath, entry);
    console.log(`[ok] Logged Ad ID ${ad.id} → docs/META-ADS-SETUP.md`);
  } catch (e) {
    console.log(`[warn] could not append to docs/META-ADS-SETUP.md: ${e.message || e} — Ad ID ${ad.id}`);
  }
  console.log(`\n${line}\nTerminé. Ad ${ad.id} PAUSED — activer manuellement dans Ads Manager.\n${line}`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
