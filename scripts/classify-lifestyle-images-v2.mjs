// Lifestyle-image classifier V2 — RE-CHECK of NO_LIFESTYLE products across ALL image
// positions (v1 only looked at the first 4). READ-ONLY on Shopify (GET only, NO writes).
//
// Source list: the NO_LIFESTYLE products from lifestyle-classification-first759.detail.json.
// For each: GET /products/{id}/images.json (ALL positions), classify every image with
// Claude Vision (same SYSTEM_PROMPT + claude-sonnet-4-6, 1 image/call), then pick the best
// lifestyle_no_people image with has_text_overlay=false across ALL positions.
//
// Rate limits: Shopify 2 req/sec (500ms), Claude 1 req/sec (1000ms).
// Run under node-x64:  node scripts/classify-lifestyle-images-v2.mjs [target] [maxSeconds]
//   target     (default 30)  — stop once this many products are in the checkpoint (STOP gate)
//   maxSeconds (default 540)  — exit this window after N seconds (env kills bg jobs ~5min;
//                               foreground windows ~9.5min). Resume by re-running.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

// ---------- env ----------
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
const SHOP_TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
if (!SHOP_TOKEN || !ANTHROPIC_KEY) throw new Error("Missing SHOPIFY_ACCESS_TOKEN or ANTHROPIC_API_KEY in .env.local");

const TARGET = Number(process.argv[2] || 30);
const MAX_SECONDS = Number(process.argv[3] || 540);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pacing ----------
let lastShop = 0, lastClaude = 0;
async function paceShop() { const w = 500 - (Date.now() - lastShop); if (w > 0) await sleep(w); lastShop = Date.now(); }
async function paceClaude() { const w = 1000 - (Date.now() - lastClaude); if (w > 0) await sleep(w); lastClaude = Date.now(); }

async function shopGet(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await paceShop();
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": SHOP_TOKEN, "Content-Type": "application/json" } });
    if (res.status === 429) { const wait = Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10); await sleep(wait * 1000); continue; }
    if (!res.ok) throw new Error(`Shopify GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }
  throw new Error("Shopify GET failed after retries (429)");
}
async function fetchAllImages(id) {
  const res = await shopGet(`https://${STORE}/admin/api/${API}/products/${id}/images.json`);
  const body = await res.json();
  return (body.images || []).slice().sort((a, b) => a.position - b.position);
}

// ---------- image helpers ----------
function resizedUrl(src) {
  const [path, query] = src.split("?");
  const resized = path.replace(/(\.[a-zA-Z]+)$/, "_1024x1024$1");
  return query ? `${resized}?${query}` : resized;
}
function mediaTypeFor(src) {
  const path = src.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}
async function downloadBase64(src) {
  const res = await fetch(resizedUrl(src));
  if (!res.ok) throw new Error(`img download ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString("base64");
}

// ---------- classify (identical prompt/model to v1) ----------
const SYSTEM_PROMPT = `Tu es un classificateur d'images e-commerce. Pour chaque image fournie, réponds UNIQUEMENT en JSON avec ce format exact :
{
  "position": <numéro de position>,
  "classification": "<white_background|lifestyle_no_people|lifestyle_with_people|detail|other>",
  "has_text_overlay": <true|false>,
  "confidence": <0.0 à 1.0>,
  "reason": "<une phrase courte>"
}

Définitions :
- white_background : produit sur fond blanc ou uni (studio), sans mise en scène
- lifestyle_no_people : produit dans un espace de vie réel ou mis en scène (salon, cuisine, jardin, chambre…), SANS personne visible
- lifestyle_with_people : produit avec une ou plusieurs PERSONNES (humains) visibles
- detail : gros plan sur un détail/texture/mécanisme, OU infographie de cotes/spécifications (produit sur fond uni avec flèches et mesures) — ce n'est PAS une scène
- other : autre

Règles importantes :
- Les ANIMAUX (chats, chiens…) ne comptent PAS comme des personnes. Une scène de vie avec un animal mais sans humain = lifestyle_no_people.
- Le TEXTE MARKETING INCRUSTÉ (ex. "MULTI-LEVEL FUN") ne change PAS la classification : une scène de vie mise en scène sans personne reste lifestyle_no_people. Mets simplement has_text_overlay:true.
- has_text_overlay = true s'il y a du texte/logo/graphisme promotionnel incrusté sur l'image ; false si l'image est propre.
- Distingue bien : infographie de dimensions sur fond uni = detail ; scène de vie (même avec du texte) = lifestyle_no_people / lifestyle_with_people.`;

async function classifyImage(b64, mediaType, position) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await paceClaude();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: `Classifie cette image (position ${position}).` },
        ] }],
      }),
    });
    if (res.status === 429 || res.status >= 500) { const wait = Math.min(parseFloat(res.headers.get("retry-after") || String(2 * (attempt + 1))), 30); await sleep(wait * 1000); continue; }
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error(`no JSON in Claude reply: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(jm[0]);
    return { classification: parsed.classification, has_text_overlay: parsed.has_text_overlay === true, confidence: Number(parsed.confidence), reason: parsed.reason };
  }
  throw new Error("Claude failed after retries");
}

// ---------- derive v2 ----------
function deriveV2(p, classifications) {
  const total = classifications.length;
  const errored = classifications.some((c) => c.classification === "ERROR");
  const life = classifications.filter((c) => c.classification === "lifestyle_no_people");
  const clean = life.filter((c) => c.has_text_overlay === false).sort((a, b) => b.confidence - a.confidence);
  const textOnly = life.filter((c) => c.has_text_overlay === true).sort((a, b) => b.confidence - a.confidence);
  let best = null, action;
  if (clean.length) { best = clean[0]; action = "SWAP_CLEAN"; }
  else if (textOnly.length) { best = textOnly[0]; action = "SWAP_TEXT"; }
  else { best = null; action = "STILL_NO_LIFESTYLE"; }
  const row = {
    shopify_product_id: p.id, handle: p.handle, title: p.title,
    total_images: total,
    best_lifestyle_position: best ? best.position : "",
    best_lifestyle_url: best ? best.src.split("?")[0] : "",
    has_text_overlay: best ? best.has_text_overlay : "",
    action,
  };
  const detail = { id: p.id, handle: p.handle, title: p.title, total_images: total, action, images: classifications, hadError: errored };
  return { row, detail };
}

// ---------- CSV ----------
function csvCell(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
const HEADER = ["shopify_product_id", "handle", "title", "total_images", "best_lifestyle_position", "best_lifestyle_url", "has_text_overlay", "action"];

// ---------- main ----------
const started = Date.now();
// STEP 1: NO_LIFESTYLE list from the v1 detail.json
const v1 = JSON.parse(readFileSync(new URL("../lifestyle-classification-first759.detail.json", import.meta.url), "utf8"));
const noLifestyle = v1.filter((x) => x.action === "NO_LIFESTYLE").map((x) => ({ id: x.id, handle: x.handle, title: x.title }));
process.stderr.write(`NO_LIFESTYLE products: ${noLifestyle.length}\n`);

// resume from checkpoint
const ckptFile = new URL("../lifestyle-classification-v2.checkpoint.jsonl", import.meta.url);
const done = new Map();
if (existsSync(ckptFile)) {
  for (const line of readFileSync(ckptFile, "utf8").split(/\r?\n/)) { if (!line.trim()) continue; try { const o = JSON.parse(line); done.set(String(o.detail.id), o); } catch {} }
  process.stderr.write(`Resume: ${done.size} products already in checkpoint.\n`);
}

let processedThisWindow = 0;
for (const p of noLifestyle) {
  if (done.size >= TARGET) break;                                   // STOP gate reached
  if ((Date.now() - started) / 1000 > MAX_SECONDS) { process.stderr.write(`Time budget ${MAX_SECONDS}s reached — exiting window (resume by re-running).\n`); break; }
  if (done.has(String(p.id))) continue;
  let images;
  try { images = await fetchAllImages(p.id); }
  catch (e) { process.stderr.write(`  ${p.id} images GET ERROR ${e.message}\n`); const rec = deriveV2(p, [{ position: 0, src: "", classification: "ERROR", confidence: 0, reason: e.message }]); done.set(String(p.id), rec); appendFileSync(ckptFile, JSON.stringify(rec) + "\n"); continue; }
  const classifications = [];
  for (const img of images) {
    try {
      const b64 = await downloadBase64(img.src);
      const c = await classifyImage(b64, mediaTypeFor(img.src), img.position);
      classifications.push({ position: img.position, src: img.src, ...c });
      process.stderr.write(`  [${done.size + 1}/${TARGET}] ${p.id} pos${img.position}/${images.length} -> ${c.classification}${c.has_text_overlay ? "+text" : ""} (${c.confidence})\n`);
    } catch (e) {
      classifications.push({ position: img.position, src: img.src, classification: "ERROR", confidence: 0, reason: String(e.message).slice(0, 120) });
      process.stderr.write(`  ${p.id} pos${img.position} -> ERROR ${e.message}\n`);
    }
  }
  const rec = deriveV2(p, classifications);
  done.set(String(p.id), rec);
  appendFileSync(ckptFile, JSON.stringify(rec) + "\n");
  processedThisWindow++;
}

// build CSV from checkpoint, ordered by the NO_LIFESTYLE list, capped at TARGET
const ordered = noLifestyle.map((p) => done.get(String(p.id))).filter(Boolean).slice(0, TARGET);
const rows = ordered.map((o) => o.row);
const csv = [HEADER.join(","), ...rows.map((r) => HEADER.map((h) => csvCell(r[h])).join(","))].join("\n");
writeFileSync(new URL("../lifestyle-classification-v2-no_lifestyle_recheck.csv", import.meta.url), csv);

const byAction = rows.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
process.stderr.write(`\nWINDOW DONE in ${Math.round((Date.now() - started) / 1000)}s. this window: +${processedThisWindow}. checkpoint total: ${done.size}. CSV rows: ${rows.length}. actions: ${JSON.stringify(byAction)}\n`);
