// Create Meta VIDEO sales-ad creatives + ad sets + ads from the rendered Demand Gen
// videos already uploaded to Meta (video_demand_gen.meta_video_id).
//
// IMPORTANT — why this is NOT a catalog/DPA creative:
//   A Meta dynamic-catalogue (product-set) creative pulls media FROM the feed
//   (asset_feed_spec: ad_formats:["CAROUSEL","COLLECTION"] + FORMAT_AUTOMATION) and
//   REJECTS an uploaded video (AUTOMATIC_FORMAT → code 100 / subcode 1885373). The
//   account has ZERO working video+product_set creatives. So this builds the proven
//   shape instead: a plain VIDEO sales ad (object_story_spec.video_data) whose
//   call_to_action links to the SKU's own product page. One video → one product.
//
// Each video maps to its SKU's Shopify product page (products.shopify_handle).
// Selection: top-N SKUs (default 6) among those with a 9:16 meta_video_id, ranked by
// the catalog's 14-day units_moved velocity (same metric as meta-ads-dpa-create.mjs).
// One duration per SKU (prefer 15s, else the longest available).
//
// SAFETY: DRY-RUN by default — prints the selected SKUs + every payload and sends
// NOTHING. --apply creates the objects, ALL PAUSED — nothing spends until activated
// in Ads Manager after review. Stops hard on OAuth #190.
//
// Run under x64 node (bun-x64 crashes on network — see CLAUDE.md "Windows ARM64"):
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/create-meta-video-adsets.mjs
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/create-meta-video-adsets.mjs --limit 6
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/create-meta-video-adsets.mjs --apply
//
// Flags:
//   --apply                  actually POST to the Marketing API (default: dry-run)
//   --limit <N>              number of top SKUs to build (default 6; clamped 1..32)
//   --daily-budget <cents>   per-ad-set daily budget, account minor units (default 500 = $5)
//   --objective <obj>        campaign objective (default OUTCOME_TRAFFIC)
//   --campaign-id <id>       reuse an existing campaign instead of creating one (resume)
//   --ad-account <act_…>     override the ad account id

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Constants (mirror meta-ads-dpa-create.mjs for this account) ──────────────
const GRAPH = "https://graph.facebook.com/v18.0";
const PAGE_ID = "1057151924144231";
const STORE_URL = "https://ameublodirect.ca";
const MESSAGE = "Préparez votre été ☀️ Livraison gratuite partout au Québec.";
const DOCS_PATH = join(ROOT, "docs", "META-ADS-SETUP.md");

function loadEnv() {
  const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const flag = (name) => { const i = process.argv.indexOf(`--${name}`); return i !== -1 ? process.argv[i + 1] : undefined; };
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

const APPLY = process.argv.includes("--apply");
const LIMIT = Math.min(32, Math.max(1, parseInt(flag("limit") || "6", 10)));
const DAILY_BUDGET = Math.max(100, parseInt(flag("daily-budget") || "500", 10));
const OBJECTIVE = flag("objective") || "OUTCOME_TRAFFIC";
const REUSE_CAMPAIGN_ID = flag("campaign-id");

const env = loadEnv();
const TOKEN = env.META_ACCESS_TOKEN;
const AD_ACCOUNT = (() => { const a = flag("ad-account") || env.META_AD_ACCOUNT_ID || "20658834"; return a.startsWith("act_") ? a : `act_${a}`; })();
if (!TOKEN) fail("META_ACCESS_TOKEN not set in .env.local");
if (!env.TURSO_DATABASE_URL) fail("TURSO_DATABASE_URL not set in .env.local");

// ── Graph helper (stops hard on OAuth #190) ──────────────────────────────────
class TokenError extends Error {}
async function graph(path, { method = "GET", body, params = {} } = {}) {
  const url = new URL(`${GRAPH}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const init = { method };
  if (body) { init.headers = { "Content-Type": "application/json" }; init.body = JSON.stringify(body); }
  const res = await fetch(url.toString(), init);
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    if (data.error.code === 190) throw new TokenError(`Meta OAuth token error #190: ${data.error.message}`);
    throw new Error(`Meta API: ${data.error.error_user_msg || data.error.message}${data.error.code ? ` (code ${data.error.code})` : ""}`);
  }
  if (!res.ok) throw new Error(`Meta API HTTP ${res.status} on ${path}`);
  return data;
}

// ── Select top-N SKUs (9:16 meta_video_id), best duration each ───────────────
const cutoff14d = Math.floor(Date.now() / 1000) - 14 * 86400;
async function selectVideos(db) {
  // one row per SKU: its 9:16 videos, ranked by 14-day units_moved.
  const r = await db.execute({
    sql: `SELECT v.sku, v.duration_sec, v.meta_video_id, v.title_fr, p.name, p.price, p.shopify_handle, p.qty,
            COALESCE((SELECT SUM(old_qty-new_qty) FROM price_history ph
                       WHERE ph.sku=v.sku AND ph.detected_at>? AND ph.change_type='stock_change' AND ph.old_qty>new_qty),0) AS units
          FROM video_demand_gen v
          JOIN products p ON p.sku = v.sku
         WHERE v.ratio='9:16' AND v.meta_video_id IS NOT NULL AND v.meta_video_id != ''
           AND p.shopify_handle IS NOT NULL AND p.shopify_handle != ''`,
    args: [cutoff14d],
  });
  // group by sku, choose duration (15s preferred, else max), keep velocity
  const bySku = new Map();
  for (const row of r.rows) {
    const e = bySku.get(row.sku) || { sku: row.sku, name: row.name, price: row.price, handle: row.shopify_handle, units: Number(row.units), vids: [] };
    e.vids.push({ duration_sec: Number(row.duration_sec), meta_video_id: String(row.meta_video_id), title_fr: row.title_fr });
    bySku.set(row.sku, e);
  }
  const picked = [];
  for (const e of bySku.values()) {
    const v15 = e.vids.find((x) => x.duration_sec === 15);
    const chosen = v15 || e.vids.slice().sort((a, b) => b.duration_sec - a.duration_sec)[0];
    picked.push({ ...e, duration_sec: chosen.duration_sec, meta_video_id: chosen.meta_video_id, title_fr: chosen.title_fr });
  }
  picked.sort((a, b) => b.units - a.units || b.price - a.price);
  return picked.slice(0, LIMIT);
}

// ── Build payloads ───────────────────────────────────────────────────────────
const campaignPayload = {
  name: "Vidéos produit — Test (CA)",
  objective: OBJECTIVE,
  status: "PAUSED",
  special_ad_categories: ["NONE"],
};
function adSetPayload(v) {
  return {
    name: `Vidéo — ${v.sku}`,
    optimization_goal: "LANDING_PAGE_VIEWS",
    billing_event: "IMPRESSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    daily_budget: String(DAILY_BUDGET),
    // Facebook-only: this account has no ads-linked Instagram account, so an all-placements
    // set would force the ad to demand an IG actor it can't supply (see meta-ads-dpa-create.mjs).
    targeting: { geo_locations: { countries: ["CA"] }, publisher_platforms: ["facebook"], age_min: 18, age_max: 65 },
    status: "PAUSED",
  };
}
function creativePayload(v) {
  const link = `${STORE_URL}/products/${v.handle}`;
  const title = String(v.title_fr || v.name || v.sku).slice(0, 90);
  return {
    name: `Vidéo — ${v.sku} ${title}`.slice(0, 100),
    object_story_spec: {
      page_id: PAGE_ID,
      video_data: {
        video_id: v.meta_video_id,
        title,
        message: MESSAGE,
        link_description: `$${v.price}`,
        call_to_action: { type: "SHOP_NOW", value: { link } },
        // image_url (video thumbnail) is fetched from GET /{video_id}?fields=picture at --apply;
        // Meta requires a thumbnail for video_data. (Filled in the apply loop below.)
      },
    },
  };
}
const adPayload = (v) => ({ name: `Vidéo — ${v.sku} — annonce`, status: "PAUSED" });

function logToDocs(rows, campaignId) {
  const stamp = new Date().toISOString().slice(0, 10);
  const heading = "## Vidéos produit — annonces vidéo (PAUSED)";
  let entry = `\n- ${stamp} — **Vidéos produit — Test (CA)** (${rows.length} SKUs, $${(DAILY_BUDGET/100).toFixed(2)}/j chacun, ${OBJECTIVE}, PAUSED)\n  - campaign: \`${campaignId}\`\n`;
  for (const r of rows) entry += `  - ${r.sku} (${r.duration_sec}s): creative \`${r.creativeId}\` · adset \`${r.adSetId}\` · ad \`${r.adId}\`\n`;
  const existing = existsSync(DOCS_PATH) ? readFileSync(DOCS_PATH, "utf8") : "";
  appendFileSync(DOCS_PATH, existing.includes(heading) ? entry : `\n${heading}\n${entry}`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
const { createClient } = await import("@libsql/client");
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const vids = await selectVideos(db);

const totalDaily = (vids.length * DAILY_BUDGET) / 100;
console.log(`Meta video ad sets — ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`  account   : ${AD_ACCOUNT}   page: ${PAGE_ID}`);
console.log(`  objective : ${OBJECTIVE}   placements: facebook   geo: CA`);
console.log(`  selected  : ${vids.length} SKUs (top by 14-day units_moved, 9:16, one duration each)`);
console.log(`  budget    : $${(DAILY_BUDGET/100).toFixed(2)}/day each  →  $${totalDaily.toFixed(2)}/day total  (~$${(totalDaily*30).toFixed(0)}/mo if all activated)\n`);

if (!vids.length) { console.log("No eligible videos. Nothing to build."); await db.close?.(); process.exit(0); }

console.log("=== selected SKUs ===");
for (const v of vids) {
  console.log(`  ${v.sku.padEnd(14)} units=${String(v.units).padStart(4)}  ${v.duration_sec}s  vid=${v.meta_video_id}  $${v.price}  → /products/${v.handle}`);
}
console.log(`\n=== campaign payload (POST /${AD_ACCOUNT}/campaigns) ===`);
console.log(JSON.stringify(campaignPayload, null, 2));
console.log(`\n=== per-SKU payloads (adset → creative → ad), example for ${vids[0].sku} ===`);
console.log("ADSET   POST /" + AD_ACCOUNT + "/adsets:\n" + JSON.stringify(adSetPayload(vids[0]), null, 2));
console.log("CREATIVE POST /" + AD_ACCOUNT + "/adcreatives:\n" + JSON.stringify(creativePayload(vids[0]), null, 2));
console.log("AD      POST /" + AD_ACCOUNT + "/ads:\n" + JSON.stringify({ ...adPayload(vids[0]), adset_id: "<adset_id>", creative: { creative_id: "<creative_id>" } }, null, 2));

if (!APPLY) {
  console.log(`\n── DRY RUN — nothing sent, no spend, DB untouched. ──`);
  console.log(`Total objects that WOULD be created: 1 campaign + ${vids.length} adsets + ${vids.length} creatives + ${vids.length} ads (all PAUSED).`);
  console.log(`Total daily budget if activated: $${totalDaily.toFixed(2)}/day.`);
  console.log(`Review above, then (after the gate) re-run with --apply.`);
  await db.close?.();
  process.exit(0);
}

// ── APPLY (every object PAUSED) ──────────────────────────────────────────────
try {
  console.log("\nPreflight: checking token …");
  const dbg = await graph("debug_token", { params: { input_token: TOKEN } });
  if (!dbg.data?.is_valid) fail("Token is not valid (debug_token). Rotate per docs/META-TOKEN-ROTATION.md.");
  if (!(dbg.data?.scopes ?? []).includes("ads_management")) fail("Token lacks ads_management scope.");
  console.log("  token valid, ads_management present.");

  let campaign;
  if (REUSE_CAMPAIGN_ID) { campaign = { id: REUSE_CAMPAIGN_ID }; console.log(`\nReusing campaign ${REUSE_CAMPAIGN_ID}.`); }
  else { console.log("\nCreating campaign (PAUSED) …"); campaign = await graph(`${AD_ACCOUNT}/campaigns`, { method: "POST", body: campaignPayload }); console.log("  campaign_id =", campaign.id); }

  const created = [];
  for (const v of vids) {
    console.log(`\n${v.sku}: thumbnail → adset → creative → ad …`);
    const pic = await graph(v.meta_video_id, { params: { fields: "picture" } }).catch(() => ({}));
    const creativeBody = creativePayload(v);
    if (pic.picture) creativeBody.object_story_spec.video_data.image_url = pic.picture;
    const adSet = await graph(`${AD_ACCOUNT}/adsets`, { method: "POST", body: { ...adSetPayload(v), campaign_id: campaign.id } });
    const creative = await graph(`${AD_ACCOUNT}/adcreatives`, { method: "POST", body: creativeBody });
    const ad = await graph(`${AD_ACCOUNT}/ads`, { method: "POST", body: { ...adPayload(v), adset_id: adSet.id, creative: { creative_id: creative.id } } });
    console.log(`  adset=${adSet.id} creative=${creative.id} ad=${ad.id}`);
    created.push({ sku: v.sku, duration_sec: v.duration_sec, adSetId: adSet.id, creativeId: creative.id, adId: ad.id });
  }

  logToDocs(created, campaign.id);
  console.log(`\n✓ Created ${created.length} video ads (all PAUSED) in campaign ${campaign.id}. Logged to docs/META-ADS-SETUP.md.`);
  console.log(`  Review + activate: https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT.replace("act_", "")}`);
  await db.close?.();
  process.exit(0);
} catch (err) {
  await db.close?.();
  if (err instanceof TokenError) {
    console.error(`\n✗ STOP — ${err.message}\n  Rotate the token per docs/META-TOKEN-ROTATION.md. Nothing further was created.`);
    process.exit(2);
  }
  console.error(`\n✗ Creation failed: ${err.message}\n  Some PAUSED objects may exist — check Ads Manager before re-running (or pass --campaign-id to resume).`);
  process.exit(1);
}
