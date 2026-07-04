// PHASE 1 STEP 3 (batch) — same target/checkpoint/derive as lifestyle-classify-304.mjs
// but classifies ALL images of a product in ONE Claude call (chunked at 20) for speed.
// Shares the SAME checkpoint (lifestyle-classification-304.checkpoint.jsonl) so the
// per-image records already written are reused. READ-ONLY on Shopify. Windowed.
//   node scripts/lifestyle-classify-304-batch.mjs [maxSeconds]
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01";
const SHOP_TOKEN = env.SHOPIFY_ACCESS_TOKEN, ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
if (!SHOP_TOKEN || !ANTHROPIC_KEY) { console.error("FATAL: missing tokens"); process.exit(2); }
const MAX_SECONDS = Number(process.argv[2] || 500), CHUNK = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastShop = 0, lastClaude = 0;
async function paceShop() { const w = 500 - (Date.now() - lastShop); if (w > 0) await sleep(w); lastShop = Date.now(); }
async function paceClaude() { const w = 1000 - (Date.now() - lastClaude); if (w > 0) await sleep(w); lastClaude = Date.now(); }

async function shopGet(url) {
  for (let a = 0; a < 6; a++) {
    await paceShop();
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOP_TOKEN } });
    if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; }
    if (res.status === 401 || res.status === 403) { console.error(`FATAL: Shopify ${res.status} — token invalid. Stopping.`); process.exit(2); }
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    return res;
  }
  throw new Error("Shopify GET failed");
}
async function fetchAllImages(id) { const b = await (await shopGet(`https://${STORE}/admin/api/${API}/products/${id}/images.json`)).json(); return (b.images || []).slice().sort((a, b) => a.position - b.position); }
function resizedUrl(src) { const [p, q] = src.split("?"); const r = p.replace(/(\.[a-zA-Z]+)$/, "_1024x1024$1"); return q ? `${r}?${q}` : r; }
function mediaTypeFor(src) { const p = src.split("?")[0].toLowerCase(); if (p.endsWith(".png")) return "image/png"; if (p.endsWith(".webp")) return "image/webp"; if (p.endsWith(".gif")) return "image/gif"; return "image/jpeg"; }
async function downloadBase64(src) { const res = await fetch(resizedUrl(src)); if (!res.ok) throw new Error(`img ${res.status}`); return Buffer.from(await res.arrayBuffer()).toString("base64"); }

const SYSTEM_PROMPT = `Tu es un classificateur d'images e-commerce.

Définitions :
- white_background : produit sur fond blanc ou uni (studio), sans mise en scène
- lifestyle_no_people : produit dans un espace de vie réel ou mis en scène (salon, cuisine, jardin, chambre…), SANS personne visible
- lifestyle_with_people : produit avec une ou plusieurs PERSONNES (humains) visibles
- detail : gros plan sur un détail/texture/mécanisme, OU infographie de cotes/spécifications (produit sur fond uni avec flèches et mesures) — ce n'est PAS une scène
- other : autre

Règles importantes :
- Les ANIMAUX (chats, chiens…) ne comptent PAS comme des personnes. Une scène de vie avec un animal mais sans humain = lifestyle_no_people.
- Le TEXTE MARKETING INCRUSTÉ (ex. "MULTI-LEVEL FUN") ne change PAS la classification : une scène de vie mise en scène sans personne reste lifestyle_no_people. Mets simplement has_text_overlay:true.
- has_text_overlay = true s'il y a du texte/logo/graphisme promotionnel incrusté ; false si l'image est propre.
- Distingue bien : infographie de dimensions sur fond uni = detail ; scène de vie (même avec du texte) = lifestyle_no_people / lifestyle_with_people.`;

async function classifyBatch(items) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await paceClaude();
    const content = [];
    for (const it of items) { content.push({ type: "text", text: `--- Image position ${it.position} ---` }); content.push({ type: "image", source: { type: "base64", media_type: it.media, data: it.b64 } }); }
    content.push({ type: "text", text: `Classifie CHAQUE image ci-dessus. Réponds UNIQUEMENT avec un tableau JSON, un objet par image, dans l'ordre, avec la bonne "position" : [{"position":N,"classification":"...","has_text_overlay":true|false,"confidence":0.0,"reason":"..."}]` });
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: Math.min(8000, 200 + items.length * 90), system: SYSTEM_PROMPT, messages: [{ role: "user", content }] }) });
    if (res.status === 429 || res.status >= 500) { await sleep(Math.min(parseFloat(res.headers.get("retry-after") || String(2 * (attempt + 1))), 30) * 1000); continue; }
    if (res.status === 401) { console.error("FATAL: Anthropic 401 — key invalid. Stopping."); process.exit(2); }
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    const am = text.match(/\[[\s\S]*\]/);
    if (!am) throw new Error(`no JSON array: ${text.slice(0, 120)}`);
    const arr = JSON.parse(am[0]);
    const byPos = new Map(arr.map((o) => [Number(o.position), o]));
    return items.map((it) => { const o = byPos.get(it.position); return o ? { position: it.position, classification: o.classification, has_text_overlay: o.has_text_overlay === true, confidence: Number(o.confidence), reason: o.reason } : { position: it.position, classification: "ERROR", has_text_overlay: false, confidence: 0, reason: "missing in batch reply" }; });
  }
  throw new Error("Claude batch failed");
}

function derive(p, cls) {
  const total = cls.length, errored = cls.some((c) => c.classification === "ERROR");
  const life = cls.filter((c) => c.classification === "lifestyle_no_people");
  const clean = life.filter((c) => c.has_text_overlay === false).sort((a, b) => b.confidence - a.confidence);
  const textOnly = life.filter((c) => c.has_text_overlay === true).sort((a, b) => b.confidence - a.confidence);
  let best = null, action;
  if (clean.length) { best = clean[0]; action = best.position === 1 ? "OK" : "SWAP_CLEAN"; }
  else if (textOnly.length) { best = textOnly[0]; action = "SWAP_TEXT"; }
  else { action = "STILL_NO_LIFESTYLE"; }
  const row = { shopify_product_id: p.id, handle: p.handle, title: p.title, total_images: total, best_lifestyle_position: best ? best.position : "", best_lifestyle_url: best ? best.src.split("?")[0] : "", has_text_overlay: best ? best.has_text_overlay : "", action };
  return { row, detail: { id: p.id, handle: p.handle, title: p.title, total_images: total, action, images: cls, hadError: errored } };
}
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const HEADER = ["shopify_product_id", "handle", "title", "total_images", "best_lifestyle_position", "best_lifestyle_url", "has_text_overlay", "action"];

const started = Date.now();
const map = JSON.parse(readFileSync(new URL("../lifestyle-catalog-map.json", import.meta.url), "utf8"));
const idsToDo = [...map.buckets.v1_swap_unexecuted, ...map.buckets.v1_ok];
const allById = new Map(JSON.parse(readFileSync(new URL("../catalog-all-products.json", import.meta.url), "utf8")).map((p) => [String(p.id), p]));
const targets = idsToDo.map((id) => allById.get(String(id))).filter(Boolean);
const ckptFile = new URL("../lifestyle-classification-304.checkpoint.jsonl", import.meta.url);
const done = new Map();
if (existsSync(ckptFile)) { for (const line of readFileSync(ckptFile, "utf8").split(/\r?\n/)) { if (!line.trim()) continue; try { const o = JSON.parse(line); done.set(String(o.detail.id), o); } catch {} } process.stderr.write(`Resume: ${done.size}/${targets.length} already done.\n`); }

let win = 0, timeUp = false;
async function processOne(p) {
  let images; try { images = await fetchAllImages(p.id); } catch (e) { const rec = derive(p, [{ position: 0, src: "", classification: "ERROR", has_text_overlay: false, confidence: 0, reason: e.message }]); done.set(String(p.id), rec); appendFileSync(ckptFile, JSON.stringify(rec) + "\n"); return; }
  const cls = [];
  try {
    for (let i = 0; i < images.length; i += CHUNK) {
      const chunk = images.slice(i, i + CHUNK);
      const items = await Promise.all(chunk.map(async (img) => ({ position: img.position, b64: await downloadBase64(img.src), media: mediaTypeFor(img.src) })));
      const out = await classifyBatch(items);
      out.forEach((o) => cls.push({ ...o, src: chunk.find((c) => c.position === o.position).src }));
    }
  } catch (e) { process.stderr.write(`  ${p.id} batch ERROR ${e.message}\n`); images.forEach((img) => cls.push({ position: img.position, src: img.src, classification: "ERROR", has_text_overlay: false, confidence: 0, reason: e.message })); }
  const rec = derive(p, cls); done.set(String(p.id), rec); appendFileSync(ckptFile, JSON.stringify(rec) + "\n"); win++;
  process.stderr.write(`  [${done.size}/${targets.length}] ${p.id} ${images.length}img -> ${rec.row.action}\n`);
}

const CONCURRENCY = 4;
const queue = targets.filter((p) => !done.has(String(p.id)));
let qi = 0;
async function worker() {
  while (qi < queue.length) {
    if ((Date.now() - started) / 1000 > MAX_SECONDS) { timeUp = true; return; }
    const p = queue[qi++];
    await processOne(p);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
if (timeUp) process.stderr.write(`Time budget ${MAX_SECONDS}s — exiting (resume by re-run).\n`);
const ordered = targets.map((p) => done.get(String(p.id))).filter(Boolean);
writeFileSync(new URL("../lifestyle-classification-304.csv", import.meta.url), [HEADER.join(","), ...ordered.map((o) => HEADER.map((h) => csvCell(o.row[h])).join(","))].join("\n"));
const by = ordered.reduce((m, o) => ((m[o.row.action] = (m[o.row.action] || 0) + 1), m), {});
process.stderr.write(`\nWINDOW done ${Math.round((Date.now() - started) / 1000)}s. +${win}. total ${done.size}/${targets.length}. actions ${JSON.stringify(by)}\n`);
if (done.size >= targets.length) process.stderr.write(`ALL DONE.\n`);
