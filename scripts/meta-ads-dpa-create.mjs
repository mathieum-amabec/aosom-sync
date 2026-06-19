// Create a Meta Dynamic Product Ads (PRODUCT_CATALOG_AD) campaign — summer or
// best-sellers — from the catalog. Builds the full DPA object chain:
//   product_set → campaign → ad set → ad creative → ad   (ALL created PAUSED).
//
// Distinct from scripts/meta-ads-create.mjs (which attaches a creative+ad to the
// existing FR/EN retargeting campaigns). This one builds a NEW prospecting DPA
// campaign from a catalog product set.
//
// DRY-RUN by default: prints the selected SKUs + every payload and sends NOTHING.
// --apply actually POSTs to the Marketing API. Nothing spends until the campaign is
// activated in Ads Manager after Mat's review — every object is PAUSED.
//
// Run under x64 node (bun-x64 crashes on network scripts — see CLAUDE.md "Windows ARM64"):
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/meta-ads-dpa-create.mjs --campaign summer
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/meta-ads-dpa-create.mjs --campaign bestsellers
//   & "$env:USERPROFILE\node-x64\node.exe" scripts/meta-ads-dpa-create.mjs --campaign summer --apply
//
// Flags:
//   --campaign <summer|bestsellers>   REQUIRED — which product set to build
//   --apply                           actually create (default: dry-run, sends nothing)
//   --limit <N>                       cap the SKU set (default: bestsellers 50, summer 200)
//   --daily-budget <cents>            ad set daily budget, account minor units (default 1500 = $15)
//   --product-set-id <id>             reuse an existing product set (resume a retry; skips creation)
//   --ad-account <act_…>              override the ad account id
//
// Campaign definitions (adapted to the REAL schema — see src/lib/database.ts):
//   bestsellers — products.qty>0 + shopify_product_id set, ranked by 14-day units_moved =
//     SUM(old_qty - new_qty) over price_history WHERE change_type='stock_change' AND old_qty>new_qty.
//     This mirrors the catalog's `best_sellers` sort exactly. No units_moved/units_sold/
//     stock_quantity column exists; this aggregate is the canonical "units sold" proxy. Only
//     real movers (units_moved>0) qualify.
//   summer — in-stock, live products WHERE product_type LIKE 'Patio & Garden%' (the catalog's
//     seasonal taxonomy prefix: patio furniture, loungers, umbrellas, sheds, garden beds, swings…),
//     ordered by the same 14-day velocity so the strongest summer movers lead.
//
// The Meta catalog's retailer_id == the variant SKU (src/lib/feeds/feed.ts), so the product
// set filter `{retailer_id:{is_any:[…skus]}}` matches our DB SKUs directly.
//
// If Meta returns OAuth error #190 (invalid/expired token) the script STOPS and advises
// rotating the token (see docs/META-TOKEN-ROTATION.md). It never spends.

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Constants (per the brief) ────────────────────────────────────────────────
const GRAPH = "https://graph.facebook.com/v18.0";
const PAGE_ID = "1057151924144231";
const CATALOG_ID = "384890002574549";
const STORE_URL = "https://ameublodirect.ca";
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

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");
// Reuse an already-created product set instead of creating a new one. Meta rejects a
// second set with an identical filter ((#10803) duplicate filter), so on a retry after a
// mid-chain failure, pass the product_set_id from the first run to resume cleanly.
const PRODUCT_SET_ID = flag("product-set-id");
// Same idea for the campaign: resume from an already-created campaign after a mid-chain
// failure (e.g. the ad set POST failed) instead of orphaning a fresh PAUSED campaign.
const REUSE_CAMPAIGN_ID = flag("campaign-id");
const REUSE_ADSET_ID = flag("adset-id");
const CAMPAIGN = (flag("campaign") || "").toLowerCase();
const DAILY_BUDGET = flag("daily-budget") ? Math.max(100, parseInt(flag("daily-budget"), 10)) : 1500;
if (CAMPAIGN !== "summer" && CAMPAIGN !== "bestsellers") {
  fail("--campaign is required and must be 'summer' or 'bestsellers'.");
}
const LIMIT = flag("limit")
  ? Math.max(1, parseInt(flag("limit"), 10))
  : CAMPAIGN === "summer" ? 200 : 50;

const env = loadEnv();
const TOKEN = env.META_ACCESS_TOKEN;
// OUTCOME_SALES + OFFSITE_CONVERSIONS optimizes for the PURCHASE pixel event, so the ad
// set's promoted_object needs the pixel id alongside the product set. NOTE: this is the AD
// ACCOUNT's conversion pixel, which can differ from the storefront's client-side pixel
// (NEXT_PUBLIC_META_PIXEL_ID). Referencing a pixel the ad account can't optimize against
// fails with a generic Graph "(#2) unexpected error". Override with --pixel-id.
const PIXEL_ID = flag("pixel-id") || env.META_ADS_PIXEL_ID || env.NEXT_PUBLIC_META_PIXEL_ID;
// This ad account has NO ads-linked Instagram account (act/instagram_accounts is empty),
// so the ad set runs Facebook-only placements (below) and the creative needs no IG actor.
// Pass --instagram-id only if a valid *ads* IG account id is later linked (the organic
// content-publishing IG id in INSTAGRAM_AMEUBLO_ACCOUNT_ID is a different namespace and is
// rejected as "not a valid Instagram account id").
const IG_ACTOR_ID = flag("instagram-id");
const AD_ACCOUNT = (() => {
  const a = flag("ad-account") || env.META_AD_ACCOUNT_ID || "20658834";
  return a.startsWith("act_") ? a : `act_${a}`;
})();
if (!TOKEN) fail("META_ACCESS_TOKEN not set in .env.local");
if (!env.TURSO_DATABASE_URL) fail("TURSO_DATABASE_URL not set in .env.local");

// ── Graph helper (stops hard on OAuth #190) ──────────────────────────────────
class TokenError extends Error {}
async function graph(path, { method = "GET", body, params = {} } = {}) {
  const url = new URL(`${GRAPH}/${String(path).replace(/^\//, "")}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const init = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url.toString(), init);
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    if (data.error.code === 190) {
      throw new TokenError(`Meta OAuth token error #190: ${data.error.message}`);
    }
    throw new Error(`Meta API: ${data.error.error_user_msg || data.error.message}${data.error.code ? ` (code ${data.error.code})` : ""}`);
  }
  if (!res.ok) throw new Error(`Meta API HTTP ${res.status} on ${path}`);
  return data;
}

// ── DB: select the SKU set for this campaign ─────────────────────────────────
// 14-day units-moved aggregate, identical to src/lib/database.ts best_sellers sort.
const cutoff14d = Math.floor(Date.now() / 1000) - 14 * 86400;
const PH_AGG = `(
  SELECT sku, SUM(old_qty - new_qty) AS units_moved
  FROM price_history
  WHERE detected_at > ? AND change_type = 'stock_change' AND old_qty > new_qty
  GROUP BY sku
)`;

async function selectSkus(db) {
  if (CAMPAIGN === "bestsellers") {
    // Only real movers (units_moved > 0), live + in stock, strongest first.
    const r = await db.execute({
      sql: `SELECT p.sku, p.name, p.price, p.qty, ph.units_moved
              FROM products p
              JOIN ${PH_AGG} ph ON ph.sku = p.sku
             WHERE p.qty > 0 AND p.shopify_product_id IS NOT NULL AND ph.units_moved > 0
             ORDER BY ph.units_moved DESC, p.qty DESC
             LIMIT ?`,
      args: [cutoff14d, LIMIT],
    });
    return r.rows;
  }
  // summer — in-stock, live Patio & Garden, strongest 14-day movers first.
  const r = await db.execute({
    sql: `SELECT p.sku, p.name, p.price, p.qty, COALESCE(ph.units_moved, 0) AS units_moved
            FROM products p
            LEFT JOIN ${PH_AGG} ph ON ph.sku = p.sku
           WHERE p.qty > 0 AND p.shopify_product_id IS NOT NULL
             AND p.product_type LIKE 'Patio & Garden%'
           ORDER BY units_moved DESC, p.qty DESC
           LIMIT ?`,
    args: [cutoff14d, LIMIT],
  });
  return r.rows;
}

// ── Campaign copy ────────────────────────────────────────────────────────────
const COPY = {
  summer: {
    productSetName: "Été 2026 — Patio & Jardin",
    campaignName: "Été 2026 — Patio & Jardin (DPA)",
    message: "Préparez votre été ☀️ Mobilier de patio et jardin — livraison partout au Québec.",
  },
  bestsellers: {
    productSetName: "Best-sellers 14j",
    campaignName: "Best-sellers (DPA)",
    message: "Nos best-sellers du moment 🔥 Livraison partout au Québec.",
  },
}[CAMPAIGN];

// ── Build payloads ───────────────────────────────────────────────────────────
function buildPayloads(skus) {
  const productSet = {
    name: COPY.productSetName,
    // Meta wants `filter` as a JSON string. retailer_id == our SKU (catalog feed).
    filter: JSON.stringify({ retailer_id: { is_any: skus } }),
  };
  const campaign = {
    name: COPY.campaignName,
    // ODAX objective for catalog/DPA sales. The legacy PRODUCT_CATALOG_SALES is rejected
    // by Graph v18 ((#100) invalid objective); OUTCOME_SALES + a product-set promoted_object
    // on the ad set is the current DPA path.
    objective: "OUTCOME_SALES",
    status: "PAUSED",
    special_ad_categories: ["NONE"],
    // Required by OUTCOME_SALES when budget lives on the ad set (no campaign budget):
    // Meta (#100) demands an explicit True/False. False = each ad set keeps its own budget.
    is_adset_budget_sharing_enabled: false,
  };
  const adSet = {
    name: `${COPY.campaignName} — Prospection CA`,
    // Mirrors a working catalog ad set on this account: WEBSITE destination + a promoted_object
    // carrying product_catalog_id AND product_set_id, plus the pixel + PURCHASE event for
    // OFFSITE_CONVERSIONS. (product_set_id filled in after creation.)
    destination_type: "WEBSITE",
    promoted_object: {
      product_set_id: "<product_set_id>",
      pixel_id: PIXEL_ID,
      custom_event_type: "PURCHASE",
    },
    // Facebook-only: this ad account has no ads-linked IG account, and an all-placements
    // ad set forces the ad to demand an Instagram actor it can't supply.
    targeting: { geo_locations: { countries: ["CA"] }, publisher_platforms: ["facebook"] },
    billing_event: "IMPRESSIONS",
    optimization_goal: "OFFSITE_CONVERSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    daily_budget: String(DAILY_BUDGET),
    status: "PAUSED",
  };
  const creative = {
    name: `${COPY.campaignName} — créative DPA`,
    product_set_id: "<product_set_id>",
    object_story_spec: {
      page_id: PAGE_ID,
      ...(IG_ACTOR_ID ? { instagram_actor_id: IG_ACTOR_ID } : {}),
      template_data: {
        message: COPY.message,
        link: STORE_URL,
        name: "{{product.name}}",
        description: "{{product.current_price}}",
        call_to_action: { type: "SHOP_NOW" },
      },
    },
  };
  const ad = {
    name: `${COPY.campaignName} — annonce`,
    adset_id: "<adset_id>",
    creative: { creative_id: "<creative_id>" },
    status: "PAUSED",
  };
  return { productSet, campaign, adSet, creative, ad };
}

// ── Log created ids into docs/META-ADS-SETUP.md ──────────────────────────────
function logToDocs(ids) {
  const stamp = new Date().toISOString().slice(0, 10);
  const heading = "## Été 2026 — campagnes DPA (PAUSED)";
  const entry =
    `\n- ${stamp} — **${COPY.campaignName}** (${CAMPAIGN}, ${ids.skuCount} SKUs, ${ids.dailyBudget} budget/j, PAUSED)\n` +
    `  - product_set: \`${ids.productSetId}\`\n` +
    `  - campaign: \`${ids.campaignId}\`\n` +
    `  - ad_set: \`${ids.adSetId}\`\n` +
    `  - creative: \`${ids.creativeId}\`\n` +
    `  - ad: \`${ids.adId}\`\n`;
  const existing = existsSync(DOCS_PATH) ? readFileSync(DOCS_PATH, "utf8") : "";
  const block = existing.includes(heading) ? entry : `\n${heading}\n${entry}`;
  appendFileSync(DOCS_PATH, block);
}

// ── Run ──────────────────────────────────────────────────────────────────────
const { createClient } = await import("@libsql/client");
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const rows = await selectSkus(db);
const skus = rows.map((r) => r.sku);

console.log(`Meta DPA create — ${APPLY ? "APPLY" : "DRY-RUN"}`);
console.log(`  campaign : ${CAMPAIGN}   (${COPY.campaignName})`);
console.log(`  account  : ${AD_ACCOUNT}   catalog: ${CATALOG_ID}   page: ${PAGE_ID}`);
console.log(`  SKUs     : ${skus.length}${skus.length === LIMIT ? `  (capped at --limit ${LIMIT})` : ""}\n`);

if (!skus.length) {
  console.log(`No SKUs matched for '${CAMPAIGN}'. Nothing to build.`);
  await db.close?.();
  process.exit(0);
}

console.log(`=== selected SKUs (${CAMPAIGN}) ===`);
for (const r of rows.slice(0, 30)) {
  console.log(`  ${r.sku.padEnd(16)} units_moved=${String(r.units_moved).padStart(5)}  $${r.price}  ${String(r.name ?? "").slice(0, 48)}`);
}
if (rows.length > 30) console.log(`  … and ${rows.length - 30} more`);

const payloads = buildPayloads(skus);
console.log(`\n=== 1) POST /${CATALOG_ID}/product_sets ===`);
console.log(JSON.stringify(payloads.productSet, null, 2));
console.log(`\n=== 2) POST /${AD_ACCOUNT}/campaigns ===`);
console.log(JSON.stringify(payloads.campaign, null, 2));
console.log(`\n=== 3) POST /${AD_ACCOUNT}/adsets ===`);
console.log(JSON.stringify(payloads.adSet, null, 2));
console.log(`\n=== 4) POST /${AD_ACCOUNT}/adcreatives ===`);
console.log(JSON.stringify(payloads.creative, null, 2));
console.log(`\n=== 5) POST /${AD_ACCOUNT}/ads ===`);
console.log(JSON.stringify(payloads.ad, null, 2));

if (!APPLY) {
  console.log(`\n── DRY RUN — nothing sent, no spend, DB untouched. ──`);
  console.log(`Review the SKUs + payloads above. Only after Mat's checkpoint, re-run with --apply:`);
  console.log(`  & "$env:USERPROFILE\\node-x64\\node.exe" scripts/meta-ads-dpa-create.mjs --campaign ${CAMPAIGN} --apply`);
  await db.close?.();
  process.exit(0);
}

// ── APPLY (every object PAUSED) ──────────────────────────────────────────────
try {
  console.log("\nPreflight: checking token …");
  const dbg = await graph("debug_token", { params: { input_token: TOKEN } });
  if (!dbg.data?.is_valid) fail("Token is not valid (debug_token). Rotate per docs/META-TOKEN-ROTATION.md.");
  const scopes = dbg.data?.scopes ?? [];
  if (!scopes.includes("ads_management")) fail(`Token lacks ads_management scope (has: ${scopes.join(", ") || "none"}).`);
  if (!PIXEL_ID) fail("NEXT_PUBLIC_META_PIXEL_ID not set in .env.local — required for OUTCOME_SALES purchase optimization.");
  console.log("  token valid, ads_management present.");

  let productSet;
  if (PRODUCT_SET_ID) {
    console.log(`\n1) Reusing existing product set ${PRODUCT_SET_ID} (skipping creation) …`);
    productSet = { id: PRODUCT_SET_ID };
  } else {
    console.log("\n1) Creating product set …");
    productSet = await graph(`${CATALOG_ID}/product_sets`, { method: "POST", body: payloads.productSet });
    console.log("  product_set_id =", productSet.id);
  }

  let campaign;
  if (REUSE_CAMPAIGN_ID) {
    console.log(`2) Reusing existing campaign ${REUSE_CAMPAIGN_ID} (skipping creation) …`);
    campaign = { id: REUSE_CAMPAIGN_ID };
  } else {
    console.log("2) Creating campaign (PAUSED) …");
    campaign = await graph(`${AD_ACCOUNT}/campaigns`, { method: "POST", body: payloads.campaign });
    console.log("  campaign_id =", campaign.id);
  }

  let adSet;
  if (REUSE_ADSET_ID) {
    console.log(`3) Reusing existing ad set ${REUSE_ADSET_ID} (skipping creation) …`);
    adSet = { id: REUSE_ADSET_ID };
  } else {
    console.log("3) Creating ad set (PAUSED) …");
    adSet = await graph(`${AD_ACCOUNT}/adsets`, {
      method: "POST",
      body: { ...payloads.adSet, campaign_id: campaign.id, promoted_object: { product_set_id: productSet.id, pixel_id: PIXEL_ID, custom_event_type: "PURCHASE" } },
    });
    console.log("  adset_id =", adSet.id);
  }

  console.log("4) Creating ad creative (PAUSED) …");
  const creative = await graph(`${AD_ACCOUNT}/adcreatives`, {
    method: "POST",
    body: { ...payloads.creative, product_set_id: productSet.id },
  });
  console.log("  creative_id =", creative.id);

  console.log("5) Creating ad (PAUSED) …");
  const ad = await graph(`${AD_ACCOUNT}/ads`, {
    method: "POST",
    body: { ...payloads.ad, adset_id: adSet.id, creative: { creative_id: creative.id } },
  });
  console.log("  ad_id =", ad.id);

  logToDocs({
    productSetId: productSet.id, campaignId: campaign.id, adSetId: adSet.id,
    creativeId: creative.id, adId: ad.id, skuCount: skus.length, dailyBudget: `$${(DAILY_BUDGET / 100).toFixed(2)}`,
  });

  console.log(`\n✓ Created (all PAUSED). Logged to docs/META-ADS-SETUP.md.`);
  console.log(`  Review + activate in Ads Manager: https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT.replace("act_", "")}`);
  await db.close?.();
  process.exit(0);
} catch (err) {
  await db.close?.();
  if (err instanceof TokenError) {
    console.error(`\n✗ STOP — ${err.message}`);
    console.error(`  The Meta access token is invalid/expired (error #190). Nothing was created.`);
    console.error(`  Rotate the token per docs/META-TOKEN-ROTATION.md, update .env.local + Vercel, then re-run.`);
    process.exit(2);
  }
  console.error(`\n✗ Creation failed: ${err.message}`);
  console.error(`  Some objects may have been created PAUSED before the failure — check Ads Manager before re-running.`);
  process.exit(1);
}
