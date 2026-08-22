// Post-audit minor homepage copy/asset fixes on the active DRAFT theme ONLY (DRAFT_THEME_ID, role-gated).
//   Item 1: hero/why_us/howit product-count badge "490+" -> "759+" (FR + EN) in templates/index.json
//   Item 2: (pending) swap the English-text parasol video card in home-video-showcase.liquid
// Dry-run default; --apply PUTs + verifies.
//   node scripts/homepage-minor-fixes.mjs [--apply]
import { readFileSync } from "node:fs";
import { LIVE_THEME_ID, DRAFT_THEME_ID } from "./_shopify-lib.mjs";
const env = (() => { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const e = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); e[m[1]] = v; } return e; })();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL no token"); process.exit(2); }
const DRAFT = DRAFT_THEME_ID, LIVE = LIVE_THEME_ID;
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (m, p, b) => fetch(`https://${STORE}/admin/api/${API}${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
function must(c, m) { if (!c) { console.error("ASSERT FAIL: " + m); process.exit(1); } }

const themes = (await (await api("GET", "/themes.json")).json()).themes;
const d = themes.find((t) => String(t.id) === DRAFT), l = themes.find((t) => String(t.id) === LIVE);
must(d && d.role !== "main", "draft must be non-main"); must(l && l.role === "main", "live must be main");
console.log(`Gate OK — draft "${d.name}" [${d.role}]. ${APPLY ? "*** APPLY ***" : "--- DRY RUN ---"}`);
async function getAsset(k) { const r = await api("GET", `/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(k)}`); must(r.ok, `get ${k}`); return (await r.json()).asset.value; }
async function putAsset(k, v) { const r = await api("PUT", `/themes/${DRAFT}/assets.json`, { asset: { key: k, value: v } }); must(r.status === 200, `PUT ${k} -> ${r.status} ${await r.text()}`); console.log(`  PUT ${k} -> HTTP ${r.status}`); }

// ---- Item 1: 490 -> 759 in index.json ----
const idx = await getAsset("templates/index.json");
const count = (idx.match(/490/g) || []).length;
must(count === 6, `expected 6 '490' occurrences, found ${count} — aborting (unexpected)`);
const idxNew = idx.split("490").join("759");
console.log(`Item 1: replaced ${count} '490' -> '759' (hero + why_us + howit, FR+EN).`);

if (!APPLY) { console.log("\nDRY-RUN — no upload."); process.exit(0); }
await putAsset("templates/index.json", idxNew);
// verify
let ok = false;
for (let a = 0; a < 5 && !ok; a++) { const v = await getAsset("templates/index.json"); ok = !/490/.test(v) && /759\+ products|759 produits/.test(v); if (!ok) await sleep(2000); }
console.log(ok ? "  index.json: verified (0 '490' left, '759' present)" : "  WARNING: not verified");
process.exit(ok ? 0 : 1);
