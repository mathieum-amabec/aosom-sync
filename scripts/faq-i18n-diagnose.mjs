// READ-ONLY diagnostic for the FAQ-renders-in-FR-when-EN bug.
// Live theme 160606093417 (read only). Writes nothing.
import { readFileSync } from "node:fs";
function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
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
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com";
const API = "2024-01";
const LIVE = "160606093417";
const H = { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN };

async function asset(key) {
  const r = await fetch(`https://${STORE}/admin/api/${API}/themes/${LIVE}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: H });
  if (!r.ok) return { status: r.status, value: null };
  return { status: r.status, value: (await r.json()).asset.value };
}

// Flatten nested locale JSON to dotted keys.
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

// STEP 1 — locale diff
const enRaw = await asset("locales/en.default.json");
const frRaw = await asset("locales/fr.json");
console.log(`en.default.json: ${enRaw.status}, fr.json: ${frRaw.status}`);
const en = flatten(JSON.parse(enRaw.value || "{}"));
const fr = flatten(JSON.parse(frRaw.value || "{}"));
const enKeys = new Set(Object.keys(en));
const frKeys = new Set(Object.keys(fr));
const inFrNotEn = [...frKeys].filter((k) => !enKeys.has(k));
const inEnNotFr = [...enKeys].filter((k) => !frKeys.has(k));
console.log(`\n=== keys in fr.json but MISSING in en.default.json: ${inFrNotEn.length} ===`);
const rx = /faq|question|frequen|accordion/i;
console.log("--- FAQ-related among them ---");
for (const k of inFrNotEn.filter((k) => rx.test(k))) console.log(`  ${k} = ${JSON.stringify(fr[k])}`);
console.log("--- (all missing keys, first 40) ---");
for (const k of inFrNotEn.slice(0, 40)) console.log(`  ${k}`);
console.log(`\n=== keys in en.default.json but missing in fr.json: ${inEnNotFr.length} (FAQ-related) ===`);
for (const k of inEnNotFr.filter((k) => rx.test(k))) console.log(`  ${k}`);

// Any FAQ keys present in BOTH (to compare values)
console.log(`\n=== FAQ-related keys present in en.default.json: ===`);
for (const k of [...enKeys].filter((k) => rx.test(k))) console.log(`  ${k} = ${JSON.stringify(en[k])}`);

// STEP 2 — list FAQ-ish section/snippet assets
const all = (await (await fetch(`https://${STORE}/admin/api/${API}/themes/${LIVE}/assets.json`, { headers: H })).json()).assets;
console.log(`\n=== assets matching faq|question|accordion: ===`);
for (const a of all.map((a) => a.key).filter((k) => /faq|question|accordion/i.test(k)).sort()) console.log(`  ${a}`);
