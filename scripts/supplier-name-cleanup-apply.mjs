// Remove the 6 forbidden supplier brand names (Aosom + Outsunny/HOMCOM/Qaba/PawHut/Vinsetto)
// from product FR title/body + EN metafields (custom.title_en, custom.body_html_en).
// Scripted word-boundary removal + tidy; the 7 sentence-subject fields are overridden by
// Claude rewrites in supplier-rewrites-7.json (grammar restored). Shopify writes via GraphQL
// productUpdate. Resumable. SAFETY: requires --apply. 2 req/sec.
//   node scripts/supplier-name-cleanup-apply.mjs [--apply]
import { readFileSync, existsSync, appendFileSync } from "node:fs";
function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: no token"); process.exit(2); }
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const NAMES = ["Aosom", "Outsunny", "HOMCOM", "Qaba", "PawHut", "Vinsetto"];
const NAMES_RE = NAMES.join("|");
const RE = new RegExp(`\\b(${NAMES_RE})\\b`, "gi");
const PREP = "from|by|with|featuring|de|par|avec|chez";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function gql(query, variables) {
  for (let a = 0; a < 6; a++) {
    const w = 550 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now();
    const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, { method: "POST", headers: H, body: JSON.stringify({ query, variables }) });
    if (res.status === 401 || res.status === 403) { console.error(`FATAL: Shopify ${res.status}`); process.exit(2); }
    const j = await res.json();
    if (j.errors && JSON.stringify(j.errors).includes("THROTTLED")) { await sleep(3000); continue; }
    return j;
  }
  throw new Error("gql throttled out");
}
const tidyPunct = (s) => (s || "").replace(/(?:[^\S\r\n]|&nbsp;)+([.,;:!?])/gi, "$1").replace(/[^\S\r\n]{2,}/g, " ");

function transform(raw) {
  if (!raw) return { after: raw, occ: 0, awkward: false };
  const occ = (raw.match(RE) || []).length;
  if (!occ) return { after: raw, occ: 0, awkward: false };
  const subjectFlag = new RegExp(`(?:^|[.!?][")»]?\\s+|>\\s*)(${NAMES_RE})\\s+[a-z]`, "").test(raw);
  let after = raw;
  after = after.replace(new RegExp(`\\b(${NAMES_RE})['’]s\\b\\s*`, "gi"), "");
  after = after.replace(new RegExp(`\\b(${PREP})\\s+(${NAMES_RE})\\b(?=\\s*[.,;:!?]|\\s*<|\\s*$)`, "gi"), "");
  after = after.replace(RE, "");
  after = after.replace(/[^\S\r\n]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/([([{«])\s+/g, "$1").replace(/\s+([)\]}»])/g, "$1");
  const residual = /[^\S\r\n]{2,}|\s[.,;:!?]/.test(after) || new RegExp(`\\b(${NAMES_RE})\\b`, "i").test(after) || new RegExp(`\\b(${PREP})\\s*[.,;:!?]`, "i").test(after);
  return { after, occ, awkward: subjectFlag || residual };
}

// 7 Claude rewrites (override the sentence-subject fields), tidied (fixes #3 stray space).
const rewrites = new Map();
for (const o of JSON.parse(readFileSync(new URL("../supplier-rewrites-7.json", import.meta.url), "utf8"))) rewrites.set(`${o.handle}|${o.field}`, tidyPunct(o.after));

// fetch all products with the fields + metafield types
const Q = `query($cursor:String){ products(first:200, after:$cursor){ pageInfo{ hasNextPage endCursor } edges{ node{
  id handle title descriptionHtml
  titleEn: metafield(namespace:"custom", key:"title_en"){ type value }
  bodyEn: metafield(namespace:"custom", key:"body_html_en"){ type value }
} } } }`;

const plan = []; // {id, handle, descriptionHtml?, title?, metafields:[]}
let cursor = null, scanned = 0, skippedAwkward = 0;
while (true) {
  const d = await gql(Q, { cursor });
  const conn = d.data?.products; if (!conn) { console.error("ERR", JSON.stringify(d).slice(0, 300)); process.exit(1); }
  for (const { node } of conn.edges) {
    scanned++;
    const fieldsDef = [
      { field: "fr_title", raw: node.title || "", set: (v, inp) => (inp.title = v) },
      { field: "fr_body", raw: node.descriptionHtml || "", set: (v, inp) => (inp.descriptionHtml = v) },
      { field: "en_title", raw: node.titleEn?.value || "", set: (v, inp) => inp.metafields.push({ namespace: "custom", key: "title_en", type: node.titleEn?.type || "single_line_text_field", value: v }) },
      { field: "en_body", raw: node.bodyEn?.value || "", set: (v, inp) => inp.metafields.push({ namespace: "custom", key: "body_html_en", type: node.bodyEn?.type || "multi_line_text_field", value: v }) },
    ];
    const input = { id: node.id, metafields: [] };
    let changed = 0;
    for (const f of fieldsDef) {
      const t = transform(f.raw);
      if (t.occ === 0) continue;
      let newVal;
      if (t.awkward) { const ov = rewrites.get(`${node.handle}|${f.field}`); if (ov == null) { skippedAwkward++; console.error(`  SKIP (awkward, no rewrite): ${node.handle} ${f.field}`); continue; } newVal = ov; }
      else newVal = tidyPunct(t.after);
      f.set(newVal, input); changed++;
    }
    if (changed > 0) { if (!input.metafields.length) delete input.metafields; plan.push({ handle: node.handle, input, changed }); }
  }
  if (!conn.pageInfo.hasNextPage) break;
  cursor = conn.pageInfo.endCursor;
}
console.error(`Scanned ${scanned} products. Plan: ${plan.length} products to update (${skippedAwkward} awkward fields skipped).`);
if (!APPLY) { console.log(JSON.stringify({ dryRun: true, products_to_update: plan.length, skippedAwkward })); process.exit(0); }

const ckpt = new URL("../supplier-cleanup-apply.checkpoint.jsonl", import.meta.url);
const done = new Map();
if (existsSync(ckpt)) { for (const l of readFileSync(ckpt, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); done.set(o.id, o); } catch {} } console.error(`resume: ${done.size} done`); }

const M = `mutation($input: ProductInput!){ productUpdate(input:$input){ product{ id } userErrors{ field message } } }`;
let ok = 0, fail = 0, i = 0;
for (const p of plan) {
  i++;
  if (done.has(p.input.id)) { if (done.get(p.input.id).ok) ok++; continue; }
  const d = await gql(M, { input: p.input });
  const ue = d.data?.productUpdate?.userErrors || d.errors;
  const success = d.data?.productUpdate?.product?.id && (!ue || ue.length === 0);
  const rec = { id: p.input.id, handle: p.handle, ok: !!success, err: success ? null : JSON.stringify(ue || d.errors).slice(0, 200) };
  if (success) ok++; else { fail++; console.error(`  FAIL ${p.handle}: ${rec.err}`); }
  done.set(p.input.id, rec); appendFileSync(ckpt, JSON.stringify(rec) + "\n");
  if (i % 50 === 0) console.error(`  ${i}/${plan.length} ok=${ok} fail=${fail}`);
}
console.log(JSON.stringify({ products_planned: plan.length, updated_ok: ok, failed: fail, skippedAwkward }, null, 2));
