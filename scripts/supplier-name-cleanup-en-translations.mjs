// Remove forbidden supplier brand names from the EN storefront layer that PR #331 missed:
//   1) native Shopify translations (translationsRegister): keys title, body_html, locale en
//   2) custom.meta_description_en metafield (EN SEO)
// Same validated method: scripted word-boundary removal + tidy; sentence-subject fields are
// Claude-rewritten to restore grammar. Dry-run (default) writes a plan JSON + prints examples.
// --apply registers translations + sets metafields. 2 req/sec. Resumable on apply.
//   node scripts/supplier-name-cleanup-en-translations.mjs [--apply]
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const TOKEN = env.SHOPIFY_ACCESS_TOKEN, ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
if (!TOKEN || !ANTHROPIC_KEY) { console.error("FATAL: missing tokens"); process.exit(2); }
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

// --- VERIFIED regex literals (NOT template-constructed — avoids the \b-becomes-backspace bug) ---
const RE = /\b(Aosom|Outsunny|HOMCOM|Qaba|PawHut|Vinsetto)\b/gi;
const PREPDROP = /\b(from|by|with|featuring|de|par|avec|chez)\s+(Aosom|Outsunny|HOMCOM|Qaba|PawHut|Vinsetto)\b(?=\s*[.,;:!?]|\s*<|\s*$)/gi;
const POSS = /\b(Aosom|Outsunny|HOMCOM|Qaba|PawHut|Vinsetto)['’]s\b\s*/gi;
const SUBJECT = /(?:^|[.!?]["»)]?\s+|>\s*)(Aosom|Outsunny|HOMCOM|Qaba|PawHut|Vinsetto)\s+[a-z]/;
const has = (s) => RE.test(s || "");  // RE has /g — reset lastIndex before each standalone test
function hasName(s) { RE.lastIndex = 0; return RE.test(s || ""); }

function transform(raw) {
  if (!raw) return { after: raw, occ: 0, awkward: false };
  const occ = (raw.match(RE) || []).length;
  if (!occ) return { after: raw, occ: 0, awkward: false };
  const subjectFlag = SUBJECT.test(raw);
  let after = raw.replace(POSS, "").replace(PREPDROP, "").replace(RE, "");
  after = after.replace(/(?:[^\S\r\n]|&nbsp;)+([.,;:!?])/gi, "$1").replace(/[^\S\r\n]{2,}/g, " ").replace(/([([{«])\s+/g, "$1").replace(/\s+([)\]}»])/g, "$1");
  const residual = /[^\S\r\n]{2,}|\s[.,;:!?]/.test(after) || hasName(after);
  return { after, occ, awkward: subjectFlag || residual };
}
// self-test guard
(() => { const a = transform("Extend your season with this Outsunny greenhouse. Outsunny offers value."); if (hasName(a.after)) { console.error("FATAL: regex self-test failed (name survived)"); process.exit(3); } if (!a.awkward) { console.error("FATAL: subject-case not flagged"); process.exit(3); } })();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function gql(q, v) { for (let a = 0; a < 8; a++) { const w = 600 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); const r = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, { method: "POST", headers: H, body: JSON.stringify({ query: q, variables: v }) }); if (r.status === 401 || r.status === 403) { console.error(`FATAL Shopify ${r.status}`); process.exit(2); } const j = await r.json(); if (j.errors && JSON.stringify(j.errors).includes("THROTTLED")) { await sleep(2500); continue; } return j; } throw new Error("throttled out"); }

// --- Pass 1: native EN translations (title, body_html) + digests ---
const QT = `query($c:String){ translatableResources(first:100, resourceType: PRODUCT, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ resourceId translatableContent{ key digest } translations(locale:"en"){ key value } } } }`;
const items = []; // {productId, kind:'translation'|'metafield', key, value(new), digest?, before}
const digestByProdKey = new Map();
let c = null, scanned = 0;
while (true) {
  const d = await gql(QT, { c });
  const conn = d.data.translatableResources;
  for (const n of conn.nodes) {
    scanned++;
    for (const dc of (n.translatableContent || [])) digestByProdKey.set(n.resourceId + "|" + dc.key, dc.digest);
    for (const t of (n.translations || [])) {
      if (t.key !== "title" && t.key !== "body_html") continue;
      if (!hasName(t.value)) continue;
      items.push({ productId: n.resourceId, kind: "translation", key: t.key, before: t.value, digest: digestByProdKey.get(n.resourceId + "|" + t.key) });
    }
  }
  if (!conn.pageInfo.hasNextPage) break;
  c = conn.pageInfo.endCursor;
}

// --- Pass 2: custom.meta_description_en metafield ---
const QM = `query($c:String){ products(first:100, after:$c){ pageInfo{ hasNextPage endCursor } edges{ node{ id metaEn: metafield(namespace:"custom", key:"meta_description_en"){ value type } } } } }`;
c = null;
while (true) {
  const d = await gql(QM, { c });
  const conn = d.data.products;
  for (const e of conn.edges) {
    const mv = e.node.metaEn?.value;
    if (mv && hasName(mv)) items.push({ productId: e.node.id, kind: "metafield", key: "meta_description_en", type: e.node.metaEn.type || "single_line_text_field", before: mv });
  }
  if (!conn.pageInfo.hasNextPage) break;
  c = conn.pageInfo.endCursor;
}

// --- compute scripted transforms + collect awkward for Claude ---
for (const it of items) { const t = transform(it.before); it.scripted = t.after; it.awkward = t.awkward; }
const awkward = items.filter((it) => it.awkward);

// Claude rewrite the awkward ones (subject-cases)
const SYS = `Tu nettoies du contenu e-commerce EN ANGLAIS. RETIRE toutes les mentions de ces marques: Aosom, Outsunny, HOMCOM, Qaba, PawHut, Vinsetto. Quand un nom retiré était le SUJET d'une phrase, corrige la grammaire pour une phrase complète et naturelle (rétablis un sujet comme "This", "Our", "It", ou le nom du produit; recapitalise). Ne change RIEN d'autre: même langue (anglais), même ton, même contenu, même HTML/balises. Réponds UNIQUEMENT avec le texte nettoyé.`;
async function claude(text) { for (let a = 0; a < 4; a++) { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 8000, system: SYS, messages: [{ role: "user", content: text }] }) }); if (r.status === 429 || r.status >= 500) { await sleep(3000); continue; } if (!r.ok) throw new Error(`Claude ${r.status}`); const j = await r.json(); return (j.content || []).map((x) => x.text || "").join("").trim(); } throw new Error("claude failed"); }
for (const it of awkward) { it.rewrite = (await claude(it.before)).replace(/(?:[^\S\r\n]|&nbsp;)+([.,;:!?])/gi, "$1"); await sleep(500); }
for (const it of items) it.final = it.awkward ? it.rewrite : it.scripted;

// final value must be name-free
const stillDirty = items.filter((it) => hasName(it.final));
writeFileSync(new URL("../supplier-en-translations-plan.json", import.meta.url), JSON.stringify(items, null, 1));

const byKind = items.reduce((m, i) => ((m[i.kind + ":" + i.key] = (m[i.kind + ":" + i.key] || 0) + 1), m), {});
const strip = (h) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
console.log(`\n===== EN-TRANSLATIONS CLEANUP ${APPLY ? "APPLY" : "DRY-RUN"} =====`);
console.log(`Products scanned: ${scanned}`);
console.log(`Fields to fix: ${items.length}  ${JSON.stringify(byKind)}`);
console.log(`  scripted: ${items.length - awkward.length} | Claude-rewritten (subject-cases): ${awkward.length}`);
console.log(`  distinct products: ${new Set(items.map((i) => i.productId)).size}`);
console.log(`  final still-dirty (must be 0): ${stillDirty.length}`);
if (stillDirty.length) { console.error("ABORT: some finals still contain a name"); for (const s of stillDirty.slice(0, 3)) console.error("  " + s.productId + " " + s.key); if (!APPLY) process.exit(1); }

if (!APPLY) {
  console.log(`\n--- scripted examples (before -> after) ---`);
  for (const it of items.filter((i) => !i.awkward).slice(0, 4)) console.log(`[${it.key}] BEFORE: …${strip(it.before).slice(0, 95)}…\n        AFTER : …${strip(it.final).slice(0, 95)}…`);
  console.log(`\n--- Claude-rewritten subject-cases (all ${awkward.length}) ---`);
  for (const it of awkward) console.log(`[${it.key}] BEFORE: …${strip(it.before).slice(0, 95)}…\n        AFTER : …${strip(it.final).slice(0, 95)}…`);
  console.log(`\nDRY-RUN — plan written to supplier-en-translations-plan.json. Re-run with --apply.`);
  process.exit(0);
}

// --- APPLY ---
const ckpt = new URL("../supplier-en-translations-apply.checkpoint.jsonl", import.meta.url);
const done = new Set();
if (existsSync(ckpt)) for (const l of readFileSync(ckpt, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { done.add(JSON.parse(l).k); } catch {} }
const REG = `mutation($id:ID!,$tr:[TranslationInput!]!){ translationsRegister(resourceId:$id, translations:$tr){ userErrors{ message field } translations{ key } } }`;
const MSET = `mutation($mf:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors{ message field } } }`;
let ok = 0, fail = 0, i = 0;
for (const it of items) {
  i++;
  const k = it.productId + "|" + it.kind + "|" + it.key;
  if (done.has(k)) { ok++; continue; }
  let err = null;
  try {
    if (it.kind === "translation") {
      if (!it.digest) { err = "no digest"; }
      else { const d = await gql(REG, { id: it.productId, tr: [{ locale: "en", key: it.key, value: it.final, translatableContentDigest: it.digest }] }); const ue = d.data?.translationsRegister?.userErrors || d.errors; if (ue && ue.length) err = JSON.stringify(ue).slice(0, 160); }
    } else {
      const d = await gql(MSET, { mf: [{ ownerId: it.productId, namespace: "custom", key: "meta_description_en", type: it.type, value: it.final }] }); const ue = d.data?.metafieldsSet?.userErrors || d.errors; if (ue && ue.length) err = JSON.stringify(ue).slice(0, 160);
    }
  } catch (e) { err = String(e.message).slice(0, 160); }
  if (err) { fail++; console.error(`  FAIL ${it.key} ${it.productId.split("/").pop()}: ${err}`); }
  else { ok++; appendFileSync(ckpt, JSON.stringify({ k }) + "\n"); }
  if (i % 40 === 0) console.error(`  ${i}/${items.length} ok=${ok} fail=${fail}`);
}
console.log(JSON.stringify({ fields: items.length, applied_ok: ok, failed: fail }, null, 2));
