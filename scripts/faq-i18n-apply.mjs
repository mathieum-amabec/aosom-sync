// Fix FAQ i18n on the DRAFT theme 160656818281 ONLY.
// NOTE: originally targeted 160655114345, but that was an abandoned empty-shell
// draft; the real working draft ("Copie de LIVE NOW", premium desktop design) is
// 160656818281. Applied there 2026-07-03 (all 3 assets HTTP 200 + verified).
// 1) add faq.* keys to locales/en.default.json + locales/fr.json
// 2) convert snippets/agentic-faq.liquid hardcoded FR strings -> {{ ... | t }}
// Gated: refuses unless draft is unpublished and live 160606093417 is main.
// Dry-run by default; pass --apply to PUT.
import { readFileSync } from "node:fs";
function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const DRAFT = "160656818281", LIVE = "160606093417";
const H = { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" };
const APPLY = process.argv.includes("--apply");

const FR = {
  title: "Questions fréquentes",
  q1: "Quelles sont les dimensions de {{ title }} ?",
  a1: "Les dimensions complètes sont indiquées dans la section caractéristiques de la fiche. Vérifiez l'espace disponible avant l'achat pour un ajustement optimal.",
  q2: "Livrez-vous ce produit partout au Canada ?",
  a2: "Oui. Nous expédions partout au Canada. Les délais et frais estimés s'affichent au paiement selon votre code postal.",
  q3: "Comment entretenir ce produit ?",
  a3: "Nettoyez avec un linge humide et un savon doux ; évitez les abrasifs. Pour un produit d'extérieur, un rangement à l'abri hors saison prolonge sa durée de vie.",
  q4: "L'assemblage est-il requis ?",
  a4: "Le produit est livré avec les instructions et la visserie nécessaires. La plupart des montages se font à deux en moins d'une heure.",
};
const EN = {
  title: "Frequently asked questions",
  q1: "What are the dimensions of {{ title }}?",
  a1: "The full dimensions are listed in the specifications section of the product page. Check your available space before buying for the best fit.",
  q2: "Do you ship this product across Canada?",
  a2: "Yes. We ship anywhere in Canada. Estimated delivery times and fees are shown at checkout based on your postal code.",
  q3: "How do I care for this product?",
  a3: "Wipe with a damp cloth and mild soap; avoid abrasives. For outdoor products, storing it under cover in the off-season extends its lifespan.",
  q4: "Is assembly required?",
  a4: "The product ships with the necessary instructions and hardware. Most assemblies take two people under an hour.",
};

const NEW_ASSIGN = `{%- liquid
  assign q1 = 'faq.q1' | t: title: product.title
  assign a1 = 'faq.a1' | t
  assign q2 = 'faq.q2' | t
  assign a2 = 'faq.a2' | t
  assign q3 = 'faq.q3' | t
  assign a3 = 'faq.a3' | t
  assign q4 = 'faq.q4' | t
  assign a4 = 'faq.a4' | t
-%}`;

async function getAsset(themeId, key) {
  const r = await fetch(`https://${STORE}/admin/api/${API}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(key)}`, { headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN } });
  if (!r.ok) throw new Error(`getAsset ${key} @${themeId}: ${r.status}`);
  return (await r.json()).asset.value;
}
async function putAsset(themeId, key, value) {
  const r = await fetch(`https://${STORE}/admin/api/${API}/themes/${themeId}/assets.json`, { method: "PUT", headers: H, body: JSON.stringify({ asset: { key, value } }) });
  if (!r.ok) throw new Error(`putAsset ${key} @${themeId}: ${r.status} ${await r.text()}`);
  return r.json();
}
function assert(c, m) { if (!c) throw new Error("ASSERT: " + m); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Shopify asset reads are eventually-consistent right after a PUT — retry the check.
async function verifyRetry(themeId, key, test, msg, tries = 6) {
  for (let i = 0; i < tries; i++) { if (test(await getAsset(themeId, key))) return; await sleep(2500); }
  throw new Error("ASSERT (after retries): " + msg);
}

// ---- safety gate ----
const themes = (await (await fetch(`https://${STORE}/admin/api/${API}/themes.json`, { headers: { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN } })).json()).themes;
const draftT = themes.find((t) => String(t.id) === DRAFT);
const liveT = themes.find((t) => String(t.id) === LIVE);
assert(draftT && draftT.role !== "main", `draft ${DRAFT} must be non-main (is ${draftT?.role})`);
assert(liveT && liveT.role === "main", `live ${LIVE} must be main (is ${liveT?.role})`);
console.log(`Gate OK — draft "${draftT.name}" [${draftT.role}], live [${liveT.role}]`);
console.log(APPLY ? "\n*** APPLY to DRAFT ***\n" : "\n--- DRY RUN ---\n");

// ---- locales ----
for (const [key, vals] of [["locales/en.default.json", EN], ["locales/fr.json", FR]]) {
  const raw = await getAsset(DRAFT, key);
  const json = JSON.parse(raw);
  if (json.faq && json.faq.title) { console.log(`${key}: faq.* already present — skip`); continue; }
  json.faq = vals;
  const out = JSON.stringify(json, null, 2);
  console.log(`${key}: + faq.{title,q1..q4,a1..a4} (${raw.length} -> ${out.length} bytes)`);
  if (APPLY) {
    await putAsset(DRAFT, key, out);
    await verifyRetry(DRAFT, key, (s) => { try { return JSON.parse(s).faq?.title === vals.title; } catch { return false; } }, `${key} faq.title after PUT`);
    console.log(`  ${key}: PUT verified`);
  }
}

// ---- liquid ----
{
  const key = "snippets/agentic-faq.liquid";
  const v = await getAsset(DRAFT, key);
  if (/'faq\.q1'\s*\|\s*t/.test(v)) {
    console.log(`${key}: already uses | t — skip`);
  } else {
    const assignRe = /\{%-\s*liquid[\s\S]*?assign q1 =[\s\S]*?-%\}/;
    assert(assignRe.test(v), "assign block found");
    let out = v.replace(assignRe, NEW_ASSIGN);
    const titleOld = `<h2 id="agentic-faq-title" class="agentic-faq__title">Questions fréquentes</h2>`;
    const titleNew = `<h2 id="agentic-faq-title" class="agentic-faq__title">{{ 'faq.title' | t }}</h2>`;
    assert(out.includes(titleOld), "hardcoded title found");
    out = out.replace(titleOld, titleNew);
    // Ensure no hardcoded FR Q/A strings remain in the assign area.
    assert(!/assign q1 = "Quelles sont/.test(out), "old q1 assign removed");
    console.log(`${key}: assign block + title -> | t (${v.length} -> ${out.length} bytes)`);
    if (APPLY) {
      await putAsset(DRAFT, key, out);
      await verifyRetry(DRAFT, key, (s) => /'faq\.q1'\s*\|\s*t/.test(s) && s.includes(titleNew), "liquid after PUT");
      console.log(`  ${key}: PUT verified`);
    }
  }
}
console.log(APPLY ? "\nDONE (applied to draft)." : "\nDONE (dry run).");
