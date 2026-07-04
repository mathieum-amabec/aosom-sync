// PHASE 3 STEP 2 — add the "lifestyle-verified" tag to the 610 clean-pos1 products.
// MERGES with existing tags (never overwrites). Bulk-fetches all tags first (few GETs),
// then PUTs only products missing the tag. Shopify 2 req/sec. Resumable. Needs --apply.
//   node scripts/lifestyle-tag-verified.mjs [--apply]
import { readFileSync, existsSync, appendFileSync } from "node:fs";
function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: no token"); process.exit(2); }
const APPLY = process.argv.includes("--apply");
const TAG = "lifestyle-verified";
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function shop(method, path, body) { for (let a = 0; a < 6; a++) { const w = 500 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; } if (res.status === 401 || res.status === 403) { console.error(`FATAL: Shopify ${res.status}`); process.exit(2); } return res; } throw new Error("429 after retries"); }
function nextLink(h) { if (!h) return null; for (const p of h.split(",")) { const m = p.match(/<([^>]+)>;\s*rel="next"/); if (m) return m[1]; } return null; }
const tagList = (s) => (s || "").split(",").map((t) => t.trim()).filter(Boolean);

const verified = new Set(JSON.parse(readFileSync(new URL("../lifestyle-verified-ids.json", import.meta.url), "utf8")).map(String));
process.stderr.write(`${APPLY ? "*** APPLY" : "--- DRY-RUN"} — tag "${TAG}" on ${verified.size} products ***\n`);

// bulk fetch current tags
const tagsById = new Map();
let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,tags`;
while (url) { const res = await shop("GET", url.replace(`https://${STORE}/admin/api/${API}`, "")); const body = await res.json(); for (const p of body.products || []) tagsById.set(String(p.id), p.tags || ""); url = nextLink(res.headers.get("link") || res.headers.get("Link")); }
process.stderr.write(`fetched tags for ${tagsById.size} products\n`);

const needTag = [...verified].filter((id) => !tagList(tagsById.get(id)).includes(TAG));
const already = verified.size - needTag.length;
process.stderr.write(`already tagged: ${already} | need tag: ${needTag.length}\n`);
if (!APPLY) { process.stderr.write(`\nDRY-RUN — ${needTag.length} would be PUT. Re-run with --apply.\n`); console.log(JSON.stringify({ verified: verified.size, already, need: needTag.length })); process.exit(0); }

const ckpt = new URL("../lifestyle-tag-verified.checkpoint.jsonl", import.meta.url);
const done = new Map();
if (existsSync(ckpt)) { for (const l of readFileSync(ckpt, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); done.set(String(o.id), o); } catch {} } process.stderr.write(`resume: ${done.size} processed\n`); }

let i = 0, ok = 0, fail = 0;
for (const id of needTag) {
  i++;
  if (done.has(String(id))) { if (done.get(String(id)).status === 200) ok++; continue; }
  const merged = [...tagList(tagsById.get(id)), TAG].join(", ");
  let rec;
  try { const put = await shop("PUT", `/products/${id}.json`, { product: { id: Number(id), tags: merged } }); rec = { id, status: put.status }; if (put.status !== 200) { rec.error = (await put.text()).slice(0, 160); fail++; } else ok++; }
  catch (e) { rec = { id, status: "ERROR", error: String(e.message).slice(0, 160) }; fail++; }
  done.set(String(id), rec); appendFileSync(ckpt, JSON.stringify(rec) + "\n");
  if (i % 40 === 0) process.stderr.write(`  ${i}/${needTag.length} ok=${ok} fail=${fail}\n`);
}
process.stderr.write(`\n=== TAG DONE === PUT200 ${ok} | failed ${fail} | (already had tag: ${already})\n`);
console.log(JSON.stringify({ verified: verified.size, already, put_200: ok, failed: fail, total_with_tag: already + ok }));
