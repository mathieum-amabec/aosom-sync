// PHASE 2 (apply) — execute the pos-1 swaps from pos1-swap-plan-304.json.
// PUT each hero image to position 1, verify via re-GET. Shopify 2 req/sec. Resumable.
// Per-product errors logged + skipped. SAFETY: requires --apply to write.
//   node scripts/lifestyle-apply-swaps-304.mjs --apply
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
function loadEnv() { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env; }
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL: no token"); process.exit(2); }
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function shop(method, path, body) { for (let a = 0; a < 6; a++) { const w = 500 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now(); const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; } if (res.status === 401 || res.status === 403) { console.error(`FATAL: Shopify ${res.status}`); process.exit(2); } return res; } throw new Error("429 after retries"); }

const plan = JSON.parse(readFileSync(new URL("../pos1-swap-plan-304.json", import.meta.url), "utf8"));
process.stderr.write(`${APPLY ? "*** APPLY" : "--- DRY-RUN"} — ${plan.length} swaps ***\n`);
const ckpt = new URL("../pos1-apply-304.checkpoint.jsonl", import.meta.url);
const done = new Map();
if (existsSync(ckpt)) { for (const l of readFileSync(ckpt, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); done.set(String(o.id), o); } catch {} } process.stderr.write(`resume: ${done.size} processed\n`); }

let i = 0;
for (const p of plan) {
  i++;
  if (done.has(String(p.id))) continue;
  const rec = { id: p.id, handle: p.handle, title: p.title, hero_image_id: p.hero_image_id, hero_was_pos: p.hero_current_position, put_status: null, verified: null };
  if (!APPLY) { rec.put_status = "dry-run"; done.set(String(p.id), rec); appendFileSync(ckpt, JSON.stringify(rec) + "\n"); continue; }
  try {
    const put = await shop("PUT", `/products/${p.id}/images/${p.hero_image_id}.json`, { image: { id: p.hero_image_id, position: 1 } });
    rec.put_status = put.status;
    if (put.status !== 200) { rec.error = (await put.text()).slice(0, 200); process.stderr.write(`  [${i}/${plan.length}] ${p.handle} PUT ${put.status} FAIL\n`); }
    else {
      let verified = false, now = null;
      for (let a = 0; a < 4 && !verified; a++) { if (a > 0) await sleep(1000); const g = await shop("GET", `/products/${p.id}/images.json`); if (g.status !== 200) continue; const imgs = ((await g.json()).images || []).sort((x, y) => x.position - y.position); const pos1 = imgs.find((im) => im.position === 1); now = pos1 ? pos1.id : null; verified = pos1 && String(pos1.id) === String(p.hero_image_id); }
      rec.verified = verified; rec.now_pos1_id = now;
      process.stderr.write(`  [${i}/${plan.length}] ${p.handle} PUT 200 ${verified ? "VERIFIED" : "unverified"}\n`);
    }
  } catch (e) { rec.put_status = "ERROR"; rec.error = String(e.message).slice(0, 200); process.stderr.write(`  [${i}/${plan.length}] ${p.handle} ERROR ${e.message}\n`); }
  done.set(String(p.id), rec); appendFileSync(ckpt, JSON.stringify(rec) + "\n");
}
if (done.size >= plan.length) {
  const results = plan.map((p) => done.get(String(p.id)));
  const ok = results.filter((r) => r.put_status === 200);
  const verified = results.filter((r) => r.verified === true);
  const failed = results.filter((r) => r.put_status !== 200 && r.put_status !== "dry-run");
  const report = { generated_from: "pos1-swap-plan-304.json", total: plan.length, put_200: ok.length, verified: verified.length, failed: failed.length, failures: failed.map((r) => ({ id: r.id, handle: r.handle, status: r.put_status, error: r.error })) };
  writeFileSync(new URL("../pos1-swap-report-304.json", import.meta.url), JSON.stringify(report, null, 2));
  process.stderr.write(`\n=== REPORT === PUT200 ${ok.length}/${plan.length} | verified ${verified.length} | failed ${failed.length}\n`);
  console.log(JSON.stringify(report, null, 2));
} else process.stderr.write(`\nINCOMPLETE: ${done.size}/${plan.length} — rerun\n`);
