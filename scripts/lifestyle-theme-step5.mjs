// PHASE 3 STEP 5 — repoint two homepage sections on the active DRAFT theme ONLY (DRAFT_THEME_ID)
// to the lifestyle-filtered smart collections. Gated: refuses unless draft is non-main and
// the live theme (LIVE_THEME_ID) is main. Asserts the current collection handles before changing.
// Dry-run by default; --apply writes + verifies by re-GET.
//   node scripts/lifestyle-theme-step5.mjs [--apply]
import { readFileSync } from "node:fs";
import { LIVE_THEME_ID, DRAFT_THEME_ID } from "./_shopify-lib.mjs";
function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: no token"); process.exit(2); }
const DRAFT = DRAFT_THEME_ID, LIVE = LIVE_THEME_ID;
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) { const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return res; }
function assert(c, m) { if (!c) { console.error("ASSERT FAIL: " + m); process.exit(1); } }

// changes: section id -> {from, to}
const CHANGES = {
  featured_sale: { from: "rabais", to: "rabais-lifestyle" },
  featured_collection2: { from: "nouveaux-arrivages", to: "nouveaux-arrivages-lifestyle" },
};

// ---- gate ----
const themes = (await (await api("GET", "/themes.json")).json()).themes;
const d = themes.find((t) => String(t.id) === DRAFT), l = themes.find((t) => String(t.id) === LIVE);
assert(d && d.role !== "main", `draft ${DRAFT} must be non-main (is ${d?.role})`);
assert(l && l.role === "main", `live ${LIVE} must be main (is ${l?.role})`);
console.log(`Gate OK — draft "${d.name}" [${d.role}], live "${l.name}" [${l.role}]`);
console.log(APPLY ? "\n*** APPLY to DRAFT templates/index.json ***\n" : "\n--- DRY RUN ---\n");

// ---- read ----
const asset = (await (await api("GET", `/themes/${DRAFT}/assets.json?asset[key]=templates/index.json`)).json()).asset;
const json = JSON.parse(asset.value);

// idempotency + assertions
let toChange = 0;
for (const [sid, ch] of Object.entries(CHANGES)) {
  const sec = json.sections?.[sid];
  assert(sec, `section ${sid} not found`);
  const cur = sec.settings?.collection;
  if (cur === ch.to) { console.log(`  ${sid}: already "${ch.to}" — skip`); continue; }
  assert(cur === ch.from, `${sid}.collection expected "${ch.from}" but is "${cur}" — aborting (unexpected state)`);
  console.log(`  ${sid}: "${cur}" -> "${ch.to}"`);
  sec.settings.collection = ch.to;
  toChange++;
}
if (toChange === 0) { console.log("\nNothing to change (already applied)."); process.exit(0); }

if (!APPLY) { console.log(`\nDRY-RUN — ${toChange} section(s) would change. Re-run with --apply.`); process.exit(0); }

// ---- write ----
const out = JSON.stringify(json, null, 2);
const put = await api("PUT", `/themes/${DRAFT}/assets.json`, { asset: { key: "templates/index.json", value: out } });
if (put.status !== 200) { console.error(`PUT failed: ${put.status} ${(await put.text()).slice(0, 300)}`); process.exit(1); }
console.log(`  PUT templates/index.json -> HTTP ${put.status}`);

// ---- verify (Shopify assets are eventually-consistent) ----
let verified = false;
for (let a = 0; a < 6 && !verified; a++) {
  if (a > 0) await sleep(2500);
  const v = JSON.parse((await (await api("GET", `/themes/${DRAFT}/assets.json?asset[key]=templates/index.json`)).json()).asset.value);
  verified = Object.entries(CHANGES).every(([sid, ch]) => v.sections?.[sid]?.settings?.collection === ch.to);
}
console.log(verified ? "  VERIFIED — both sections now point to the lifestyle collections." : "  WARNING — could not verify after retries.");
process.exit(verified ? 0 : 1);
