// Populate the empty DRAFT 160655114345 by copying ALL assets from LIVE 160606093417.
// (Shopify has no duplicate-by-id: themeDuplicate doesn't exist; themeCreate/REST src need a
//  zip URL we can't get; themeFilesCopy is intra-theme. So copy asset-by-asset.)
// Gated: draft must be non-main, live must be main. Dry-run unless --apply.
import { readFileSync } from "node:fs";
function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const LIVE = "160606093417", DRAFT = "160655114345";
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(path, opts = {}, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`https://${STORE}/admin/api/${API}${path}`, { ...opts, headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (r.status === 429) { await sleep(Math.min(parseFloat(r.headers.get("Retry-After") || "2"), 10) * 1000); continue; }
    return r;
  }
  throw new Error(`429 exhausted for ${path}`);
}

// gate
const themes = (await (await req(`/themes.json`)).json()).themes;
const draftT = themes.find((t) => String(t.id) === DRAFT), liveT = themes.find((t) => String(t.id) === LIVE);
if (!draftT || draftT.role === "main") throw new Error(`REFUSE: draft ${DRAFT} role=${draftT?.role}`);
if (!liveT || liveT.role !== "main") throw new Error(`REFUSE: live ${LIVE} role=${liveT?.role}`);

const liveAssets = (await (await req(`/themes/${LIVE}/assets.json`)).json()).assets;
const draftExisting = new Set((await (await req(`/themes/${DRAFT}/assets.json`)).json()).assets.map((a) => a.key));
console.log(`live assets: ${liveAssets.length} | draft already has: ${draftExisting.size} (will skip those)`);
console.log(APPLY ? "*** APPLY — copying live -> draft (resume) ***\n" : "--- DRY RUN ---\n");
if (!APPLY) { console.log(`Would copy ${liveAssets.length - draftExisting.size} remaining assets into draft ${DRAFT}.`); process.exit(0); }

let ok = 0, skip = 0, fail = 0;
const failures = [];
for (let i = 0; i < liveAssets.length; i++) {
  const key = liveAssets[i].key;
  if (draftExisting.has(key)) { skip++; continue; }
  try {
    const g = await req(`/themes/${LIVE}/assets.json?asset[key]=${encodeURIComponent(key)}`);
    if (!g.ok) { fail++; failures.push(`${key} GET ${g.status}`); continue; }
    const a = (await g.json()).asset;
    let body;
    if (a.value != null) body = { key, value: a.value };
    else if (a.attachment != null) body = { key, attachment: a.attachment };
    else if (a.public_url) body = { key, src: a.public_url };
    else { skip++; continue; }
    const p = await req(`/themes/${DRAFT}/assets.json`, { method: "PUT", body: JSON.stringify({ asset: body }) });
    if (p.ok) ok++; else { fail++; failures.push(`${key} PUT ${p.status} ${(await p.text()).slice(0, 80)}`); }
  } catch (e) { fail++; failures.push(`${key} ${e.message}`); }
  if ((i + 1) % 40 === 0) console.log(`  ${i + 1}/${liveAssets.length}  ok=${ok} fail=${fail} skip=${skip}`);
  await sleep(120);
}
const draftAfter = (await (await req(`/themes/${DRAFT}/assets.json`)).json()).assets.length;
console.log(`\nDONE: ok=${ok} skip=${skip} fail=${fail} | draft assets now: ${draftAfter}`);
if (failures.length) { console.log("failures (first 20):"); failures.slice(0, 20).forEach((f) => console.log("  " + f)); }
