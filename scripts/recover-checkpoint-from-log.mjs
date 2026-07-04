// One-off: rebuild the classifier checkpoint from a killed run's stderr log.
// The log holds per-image (id, position, classification, has_text_overlay, confidence).
// We re-fetch product images (for src/handle/title) and write complete products
// into lifestyle-classification.checkpoint.jsonl so the main run resumes past them.
//   node scripts/recover-checkpoint-from-log.mjs <logfile>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logPath = process.argv[2];
if (!logPath) throw new Error("usage: node recover-checkpoint-from-log.mjs <logfile>");

// ---- parse log ----
const rx = /\[(\d+)\/\d+\]\s+(\d+)\s+pos(\d+)\s+->\s+([a-z_]+)(\+text)?\s+\(([\d.]+)\)/;
const rxErr = /\[(\d+)\/\d+\]\s+(\d+)\s+pos(\d+)\s+->\s+ERROR/;
const byId = new Map(); // id -> {idx, imgs: Map<pos,{classification,has_text_overlay,confidence}>}
let maxIdx = 0;
for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
  let m = line.match(rx);
  if (m) {
    const [, idx, id, pos, cls, txt, conf] = m;
    maxIdx = Math.max(maxIdx, Number(idx));
    if (!byId.has(id)) byId.set(id, { idx: Number(idx), imgs: new Map() });
    byId.get(id).imgs.set(Number(pos), { classification: cls, has_text_overlay: !!txt, confidence: Number(conf) });
    continue;
  }
  m = line.match(rxErr);
  if (m) {
    const [, idx, id, pos] = m;
    maxIdx = Math.max(maxIdx, Number(idx));
    if (!byId.has(id)) byId.set(id, { idx: Number(idx), imgs: new Map() });
    byId.get(id).imgs.set(Number(pos), { classification: "ERROR", has_text_overlay: false, confidence: 0 });
  }
}
process.stderr.write(`parsed ${byId.size} products from log (max idx ${maxIdx})\n`);

// ---- re-fetch products for src/handle/title ----
async function fetchAll() {
  const products = [];
  let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,handle,title,images`;
  while (url) {
    await sleep(500);
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" } });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const body = await res.json();
    products.push(...body.products);
    const link = res.headers.get("Link") || res.headers.get("link") || "";
    const mm = link.match(/<([^>]+)>;\s*rel="next"/);
    url = mm ? mm[1] : null;
  }
  return products;
}
const prods = await fetchAll();
const prodById = new Map(prods.map((p) => [String(p.id), p]));
process.stderr.write(`fetched ${prods.length} products from Shopify\n`);

// ---- derive (must match main script) ----
function derive(p, classifications) {
  const errored = classifications.some((c) => c.classification === "ERROR");
  const pos1 = classifications.find((c) => c.position === 1) || classifications[0] || null;
  const pos1Class = pos1 ? pos1.classification : "NO_IMAGE";
  const lifestyles = classifications.filter((c) => c.classification === "lifestyle_no_people");
  lifestyles.sort((a, b) => (Number(a.has_text_overlay) - Number(b.has_text_overlay)) || (b.confidence - a.confidence));
  const best = lifestyles[0] || null;
  let action;
  if (!best) action = "NO_LIFESTYLE";
  else if (pos1 && pos1.classification === "lifestyle_no_people") action = "OK";
  else action = "SWAP";
  const row = {
    shopify_product_id: p.id, handle: p.handle, title: p.title,
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

// ---- rebuild checkpoint for COMPLETE products only ----
const ckptFile = new URL("../lifestyle-classification.checkpoint.jsonl", import.meta.url);
if (existsSync(ckptFile)) throw new Error("checkpoint already exists — refusing to overwrite; delete it first if you really mean to");
const lines = [];
let complete = 0, incomplete = 0;
for (const [id, rec] of byId) {
  const p = prodById.get(id);
  if (!p) { incomplete++; continue; }
  const expected = Math.min(4, (p.images || []).length);
  if (rec.imgs.size < expected) { incomplete++; continue; } // interrupted product — let main run redo it
  const bySrc = new Map((p.images || []).map((im) => [im.position, im.src]));
  const classifications = [...rec.imgs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pos, c]) => ({ position: pos, src: bySrc.get(pos) || "", ...c, reason: "recovered from run log" }));
  lines.push(JSON.stringify(derive(p, classifications)));
  complete++;
}
writeFileSync(ckptFile, lines.join("\n") + (lines.length ? "\n" : ""));
process.stderr.write(`recovered ${complete} complete products into checkpoint; skipped ${incomplete} (interrupted/unknown)\n`);
