// Lifestyle-image classifier (READ-ONLY on Shopify — GET requests only, NO writes).
// Phase 1: paginate Shopify products (id, handle, title, images).
// Phase 2: classify up to the first 4 images/product with Claude Vision (claude-sonnet-4-6).
// Phase 3: emit a CSV + JSON detail with the recommended pos-1 action.
//
// Rate limits: Shopify 2 req/sec (500ms), Claude 1 req/sec (1000ms).
// Run under node-x64:  node scripts/classify-lifestyle-images.mjs [limit] [offset]
//   limit  (default 30) — number of products to classify (test slice)
//   offset (default 0)  — skip N products first
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

const LIMIT = Number(process.argv[2] || 30);
const OFFSET = Number(process.argv[3] || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pacing ----------
let lastShop = 0, lastClaude = 0;
async function paceShop() { const w = 500 - (Date.now() - lastShop); if (w > 0) await sleep(w); lastShop = Date.now(); }
async function paceClaude() { const w = 1000 - (Date.now() - lastClaude); if (w > 0) await sleep(w); lastClaude = Date.now(); }

// ---------- Phase 1: fetch products ----------
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

async function fetchAllProducts(maxNeeded) {
  const products = [];
  let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,handle,title,images`;
  while (url) {
    const res = await shopGet(url);
    const body = await res.json();
    products.push(...body.products);
    process.stderr.write(`  fetched ${products.length} products\n`);
    if (products.length >= maxNeeded) break;
    // pagination via Link header (rel="next")
    const link = res.headers.get("Link") || res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return products;
}

// ---------- image helpers ----------
// Ask Shopify CDN for a bounded 1024x1024 variant: insert _1024x1024 before the extension.
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
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString("base64");
}

// ---------- Phase 2: classify one image ----------
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
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: `Classifie cette image (position ${position}).` },
          ],
        }],
      }),
    });
    if (res.status === 429 || res.status >= 500) { const wait = Math.min(parseFloat(res.headers.get("retry-after") || String(2 * (attempt + 1))), 30); await sleep(wait * 1000); continue; }
    if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || "").join("");
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) throw new Error(`no JSON in Claude reply: ${text.slice(0, 120)}`);
    const parsed = JSON.parse(jm[0]);
    return { classification: parsed.classification, has_text_overlay: parsed.has_text_overlay === true, confidence: Number(parsed.confidence), reason: parsed.reason, position };
  }
  throw new Error("Claude failed after retries");
}

// ---------- CSV ----------
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Pure derivation of the row + detail record from a product's classifications.
function derive(p, classifications) {
  const errored = classifications.some((c) => c.classification === "ERROR");
  const pos1 = classifications.find((c) => c.position === 1) || classifications[0] || null;
  const pos1Class = pos1 ? pos1.classification : "NO_IMAGE";
  const lifestyles = classifications.filter((c) => c.classification === "lifestyle_no_people");
  // Prefer a CLEAN hero (no text overlay), then highest confidence.
  lifestyles.sort((a, b) => (Number(a.has_text_overlay) - Number(b.has_text_overlay)) || (b.confidence - a.confidence));
  const best = lifestyles[0] || null;
  let action;
  if (!best) action = "NO_LIFESTYLE";
  else if (pos1 && pos1.classification === "lifestyle_no_people") action = "OK";
  else action = "SWAP";
  const row = {
    shopify_product_id: p.id,
    handle: p.handle,
    title: p.title,
    current_pos1_classification: pos1Class,
    current_pos1_has_text_overlay: pos1 ? pos1.has_text_overlay : "",
    best_lifestyle_position: best ? best.position : "",
    best_lifestyle_url: best ? best.src : "",
    best_lifestyle_has_text_overlay: best ? best.has_text_overlay : "",
    confidence: best ? best.confidence : "",
    action,
  };
  const detail = { id: p.id, handle: p.handle, title: p.title, action, images: classifications, hadError: errored };
  return { row, detail };
}

// ---------- main ----------
const started = Date.now();
process.stderr.write(`Phase 1: fetching products (need ${OFFSET + LIMIT})...\n`);
const all = await fetchAllProducts(OFFSET + LIMIT);
const slice = all.slice(OFFSET, OFFSET + LIMIT);

// ---------- resume from checkpoint ----------
// One JSON line per completed product: {"row":{...},"detail":{...}}. Appended the
// instant a product finishes, so a kill loses at most the in-flight product.
const ckptFile = new URL("../lifestyle-classification.checkpoint.jsonl", import.meta.url);
const done = new Map(); // product id -> {row, detail}
if (existsSync(ckptFile)) {
  for (const line of readFileSync(ckptFile, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); done.set(String(o.detail.id), o); } catch { /* skip corrupt line */ }
  }
  process.stderr.write(`Resume: ${done.size} products already in checkpoint (will skip).\n`);
}

process.stderr.write(`Phase 2: classifying first 4 images of ${slice.length} products (offset ${OFFSET})...\n`);
let idx = 0;
for (const p of slice) {
  idx++;
  if (done.has(String(p.id))) { process.stderr.write(`  [${idx}/${slice.length}] ${p.id} skip (checkpoint)\n`); continue; }
  const images = (p.images || []).slice().sort((a, b) => a.position - b.position).slice(0, 4);
  const classifications = [];
  for (const img of images) {
    try {
      const mt = mediaTypeFor(img.src);
      const b64 = await downloadBase64(img.src);
      const c = await classifyImage(b64, mt, img.position);
      classifications.push({ position: img.position, src: img.src, ...c });
      process.stderr.write(`  [${idx}/${slice.length}] ${p.id} pos${img.position} -> ${c.classification}${c.has_text_overlay ? "+text" : ""} (${c.confidence})\n`);
    } catch (e) {
      classifications.push({ position: img.position, src: img.src, classification: "ERROR", confidence: 0, reason: String(e.message).slice(0, 120) });
      process.stderr.write(`  [${idx}/${slice.length}] ${p.id} pos${img.position} -> ERROR ${e.message}\n`);
    }
  }
  const rec = derive(p, classifications);
  done.set(String(p.id), rec);
  appendFileSync(ckptFile, JSON.stringify(rec) + "\n"); // durable, per-product
}

// ---------- build outputs from the full checkpoint (ordered by slice) ----------
const ordered = slice.map((p) => done.get(String(p.id))).filter(Boolean);
const rows = ordered.map((o) => o.row);
const detail = ordered.map((o) => o.detail);
const header = ["shopify_product_id", "handle", "title", "current_pos1_classification", "current_pos1_has_text_overlay", "best_lifestyle_position", "best_lifestyle_url", "best_lifestyle_has_text_overlay", "confidence", "action"];
const csv = [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n");
const tag = OFFSET > 0 ? `${OFFSET}-${OFFSET + slice.length}` : `first${slice.length}`;
const outCsv = new URL(`../lifestyle-classification-${tag}.csv`, import.meta.url);
const outJson = new URL(`../lifestyle-classification-${tag}.detail.json`, import.meta.url);
writeFileSync(outCsv, csv);
writeFileSync(outJson, JSON.stringify(detail, null, 2));

// summary
const byAction = rows.reduce((m, r) => ((m[r.action] = (m[r.action] || 0) + 1), m), {});
process.stderr.write(`\nDONE in ${Math.round((Date.now() - started) / 1000)}s. classified ${rows.length}/${slice.length}. actions: ${JSON.stringify(byAction)}\n`);
process.stderr.write(`CSV : ${outCsv.pathname}\n`);
process.stderr.write(`JSON: ${outJson.pathname}\n`);
console.log(csv);
