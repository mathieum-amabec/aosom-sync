// Create the first Meta Dynamic Ads (catalog retargeting) campaign + ad set.
//
// Both objects are created PAUSED — nothing spends until you activate them in
// Ads Manager after review. DRY-RUN by default: it prints the exact payloads and
// sends NOTHING. Pass --apply to actually create.
//
// Usage (run under x64 node — see CLAUDE.md / [[aosom-sync-arm64-dev]]):
//   node scripts/create-meta-dynamic-ads.mjs                          # dry-run: print payloads, send nothing
//   node scripts/create-meta-dynamic-ads.mjs --audience-id 1234567890 # dry-run with a real retargeting audience
//   node scripts/create-meta-dynamic-ads.mjs --apply --audience-id 1234567890   # actually create (PAUSED)
//
// Flags:
//   --apply                 actually POST to the Marketing API (default: dry-run)
//   --audience-id <id>      custom audience id (30-day site visitors) — REQUIRED for --apply
//   --product-set-id <id>   promote a product SET instead of the whole catalog (Meta usually wants this for catalog sales)
//   --objective <obj>       campaign objective (default: PRODUCT_CATALOG_SALES)
//   --daily-budget <cents>  ad set daily budget in the account minor unit (e.g. 1500 = $15.00)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf8");
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

const GRAPH = "https://graph.facebook.com/v18.0";
const CATALOG_ID = "1103064966519153";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const AUDIENCE_ID = flag("audience-id");
const PRODUCT_SET_ID = flag("product-set-id");
const OBJECTIVE = flag("objective") || "PRODUCT_CATALOG_SALES";
const DAILY_BUDGET = flag("daily-budget");

const env = loadEnv();
const TOKEN = env.META_ACCESS_TOKEN;
const AD_ACCOUNT = (() => {
  const a = env.META_AD_ACCOUNT_ID || "20658834";
  return a.startsWith("act_") ? a : `act_${a}`;
})();

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
if (!TOKEN) fail("META_ACCESS_TOKEN not set in .env.local");

async function graph(path, { method = "GET", body, params = {} } = {}) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const init = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), init);
  const data = await res.json().catch(() => ({}));
  if (data.error) throw new Error(`Meta API: ${data.error.error_user_msg || data.error.message}${data.error.code ? ` (code ${data.error.code})` : ""}`);
  if (!res.ok) throw new Error(`Meta API HTTP ${res.status} on ${path}`);
  return data;
}

// ── Build payloads ───────────────────────────────────────────────────────
const campaignPayload = {
  name: "Ameublo Direct — Retargeting",
  objective: OBJECTIVE,
  status: "PAUSED",
  special_ad_categories: ["NONE"],
};

// promoted_object: a product SET is what Meta expects for catalog sales; fall back
// to the whole catalog id if no set is given (confirm against your account before --apply).
const promotedObject = PRODUCT_SET_ID
  ? { product_set_id: PRODUCT_SET_ID, custom_event_type: "PURCHASE" }
  : { product_catalog_id: CATALOG_ID };

const adSetPayload = {
  campaign_id: "<campaign_id from step 1>",
  name: "Retargeting — Visiteurs 30j",
  targeting: {
    geo_locations: { countries: ["CA"] },
    custom_audiences: AUDIENCE_ID ? [{ id: AUDIENCE_ID }] : ["<REQUIRED: 30-day visitors custom audience id>"],
  },
  promoted_object: promotedObject,
  billing_event: "IMPRESSIONS",
  bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  optimization_goal: "OFFSITE_CONVERSIONS",
  status: "PAUSED",
  ...(DAILY_BUDGET ? { daily_budget: String(DAILY_BUDGET) } : {}),
};

console.log(`Ad account: ${AD_ACCOUNT}   Catalog: ${CATALOG_ID}   Objective: ${OBJECTIVE}`);
console.log("\n=== 1) POST /" + AD_ACCOUNT + "/campaigns ===");
console.log(JSON.stringify(campaignPayload, null, 2));
console.log("\n=== 2) POST /" + AD_ACCOUNT + "/adsets ===");
console.log(JSON.stringify(adSetPayload, null, 2));

if (!APPLY) {
  console.log("\n── DRY RUN — nothing sent. ──");
  console.log("Review the payloads above, then re-run with:");
  console.log("  node scripts/create-meta-dynamic-ads.mjs --apply --audience-id <30d-visitors-audience-id>");
  if (!AUDIENCE_ID) console.log("\n⚠ No --audience-id given: the ad set would have no retargeting audience.");
  process.exit(0);
}

// ── Apply ────────────────────────────────────────────────────────────────
if (!AUDIENCE_ID) {
  fail("--apply requires --audience-id (a retargeting ad set with no custom audience would target broadly and spend on cold traffic).");
}

console.log("\nPreflight: checking token …");
const dbg = await graph("debug_token", { params: { input_token: TOKEN } });
const scopes = dbg.data?.scopes ?? [];
if (!dbg.data?.is_valid) fail("Token is not valid (debug_token). Regenerate per docs/META-ADS-SETUP.md.");
if (!scopes.includes("ads_management")) fail(`Token lacks ads_management scope (has: ${scopes.join(", ") || "none"}).`);
console.log("  token valid, ads_management present.");

console.log("\nCreating campaign (PAUSED) …");
const campaign = await graph(`${AD_ACCOUNT}/campaigns`, { method: "POST", body: campaignPayload });
console.log("  campaign_id =", campaign.id);

const finalAdSet = { ...adSetPayload, campaign_id: campaign.id };
console.log("Creating ad set (PAUSED) …");
const adset = await graph(`${AD_ACCOUNT}/adsets`, { method: "POST", body: finalAdSet });
console.log("  adset_id =", adset.id);

console.log(`\n✓ Created (both PAUSED). Review + activate in Ads Manager:`);
console.log(`  https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT.replace("act_", "")}`);
