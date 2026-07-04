// STRICT re-check of lifestyle-verified pos-1 images. Improved prompt treats
// multi-panel collages and bare-studio shots as DISTINCT non-lifestyle categories
// (the lenient v2 let them fall into lifestyle_no_people). READ-ONLY (GET + Claude only).
// Builds the current tag:'lifestyle-verified' set fresh (post-swap pos-1), classifies pos-1.
//   node scripts/lifestyle-strict-recheck.mjs <checkpoint.jsonl> [maxSeconds] [conc]
import { readFileSync, appendFileSync, existsSync } from "node:fs";

function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const e = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); e[m[1]] = v; } return e; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", SHOP = env.SHOPIFY_ACCESS_TOKEN, KEY = env.ANTHROPIC_API_KEY;
const [CK] = process.argv.slice(2);
const MAX = Number(process.argv[3] || 520), CONC = Number(process.argv[4] || 8);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const STRICT_PROMPT = `Tu es un classificateur d'images e-commerce STRICT. Objectif : ne garder comme "lifestyle" QUE des photos d'un vrai espace de vie meublé, sans humain ni texte. Réponds UNIQUEMENT en JSON :
{
  "classification": "<white_background|studio_bare|multi_panel_collage|infographic|lifestyle_no_people|lifestyle_with_people|other>",
  "has_text_overlay": <true|false>,
  "confidence": <0.0 à 1.0>,
  "reason": "<une phrase courte>"
}

Définitions (applique la PREMIÈRE qui correspond, dans cet ordre) :
- multi_panel_collage : l'image est un MONTAGE de plusieurs vignettes/photos juxtaposées (2+ panneaux, grille, mosaïque, avant/après, démonstration multi-images). Même si un des panneaux est une scène de vie, un montage multi-panneaux N'EST PAS lifestyle.
- infographic : schéma de dimensions/cotes, flèches, callouts techniques sur fond uni. Ce n'est pas une scène.
- white_background : produit isolé sur fond blanc ou uni (packshot studio), sans décor.
- studio_bare : produit dans un décor STUDIO MINIMAL — sol et/ou mur nu (béton, ciment, plancher vide, cyclorama), éclairage studio, SANS véritable espace de vie meublé autour (pas de mobilier d'ambiance, végétation, déco). Ce n'est PAS lifestyle.
- lifestyle_with_people : une ou plusieurs PERSONNES (humains) visibles.
- lifestyle_no_people : produit mis en scène dans un VRAI espace de vie aménagé (salon décoré, cuisine, chambre, jardin/terrasse avec végétation et mobilier d'ambiance), SANS humain. Il faut un vrai décor de vie, pas seulement un sol/mur nu.
- other : autre.

Règles :
- Les ANIMAUX (chats, chiens, oiseaux…) ne comptent PAS comme des personnes.
- has_text_overlay = true s'il y a du texte/logo/graphisme promotionnel incrusté ; false sinon.
- Sois STRICT : en cas de doute entre studio_bare et lifestyle_no_people, choisis studio_bare si le décor se limite à un sol + mur sans mobilier d'ambiance / végétation / déco réelle.
- Un montage multi-panneaux est TOUJOURS multi_panel_collage, jamais lifestyle_no_people.`;

let last = 0;
async function shopGQL(query, variables) { for (let a = 0; a < 6; a++) { const w = 500 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); const r = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": SHOP, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) }); if (r.status === 429) { await sleep(2000); continue; } const j = await r.json(); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200)); return j.data; } throw new Error("gql retries"); }
function resized(src) { const [p, q] = src.split("?"); const r = p.replace(/(\.[a-zA-Z]+)$/, "_1024x1024$1"); return q ? `${r}?${q}` : r; }
function mt(src) { const p = src.split("?")[0].toLowerCase(); if (p.endsWith(".png")) return "image/png"; if (p.endsWith(".webp")) return "image/webp"; if (p.endsWith(".gif")) return "image/gif"; return "image/jpeg"; }
async function b64(src) { const r = await fetch(resized(src)); if (!r.ok) throw new Error(`img ${r.status}`); return Buffer.from(await r.arrayBuffer()).toString("base64"); }
async function classify(data, mediaType) { for (let a = 0; a < 6; a++) { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 200, system: STRICT_PROMPT, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }, { type: "text", text: "Classifie cette image (position 1)." }] }] }) }); if (r.status === 429 || r.status >= 500) { await sleep(Math.min(parseFloat(r.headers.get("retry-after") || String(2 * (a + 1))), 30) * 1000); continue; } if (!r.ok) throw new Error(`claude ${r.status}`); const d = await r.json(); const t = (d.content || []).map(c => c.text || "").join(""); const jm = t.match(/\{[\s\S]*\}/); if (!jm) throw new Error("no json"); const p = JSON.parse(jm[0]); return { classification: p.classification, has_text_overlay: p.has_text_overlay === true, confidence: Number(p.confidence), reason: (p.reason || "").slice(0, 110) }; } throw new Error("claude retries"); }

// build fresh tagged list
const started = Date.now();
const list = [];
let cursor = null;
while (true) {
  const d = await shopGQL(`query($c:String){ products(first:200, after:$c, query:"tag:'lifestyle-verified'"){ pageInfo{hasNextPage endCursor} nodes{ id handle title featuredImage{url} } } }`, { c: cursor });
  for (const n of d.products.nodes) list.push({ id: n.id.split("/").pop(), handle: n.handle, title: n.title, pos1_url: n.featuredImage?.url || "" });
  process.stderr.write(`fetched ${list.length}\n`);
  if (!d.products.pageInfo.hasNextPage) break; cursor = d.products.pageInfo.endCursor;
}
process.stderr.write(`TOTAL tagged now: ${list.length}\n`);

const done = new Set();
if (existsSync(CK)) for (const l of readFileSync(CK, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { done.add(String(JSON.parse(l).id)); } catch {} }
const todo = list.filter(p => !done.has(String(p.id)) && p.pos1_url);
let i = 0, proc = 0;
async function worker() { while (true) { if ((Date.now() - started) / 1000 > MAX) return; const idx = i++; if (idx >= todo.length) return; const p = todo[idx]; let rec; try { const c = await classify(await b64(p.pos1_url), mt(p.pos1_url)); rec = { id: p.id, handle: p.handle, title: p.title, pos1_url: p.pos1_url.split("?")[0], ...c }; } catch (e) { rec = { id: p.id, handle: p.handle, title: p.title, pos1_url: p.pos1_url.split("?")[0], classification: "ERROR", has_text_overlay: false, confidence: 0, reason: String(e.message).slice(0, 90) }; } appendFileSync(CK, JSON.stringify(rec) + "\n"); proc++; if (proc % 25 === 0) process.stderr.write(`  +${proc} (${done.size + proc}/${list.length}) ${Math.round((Date.now() - started) / 1000)}s\n`); } }
await Promise.all(Array.from({ length: CONC }, worker));
process.stderr.write(`WINDOW END +${proc}, ${done.size + proc}/${list.length}, ${Math.round((Date.now() - started) / 1000)}s\n`);
