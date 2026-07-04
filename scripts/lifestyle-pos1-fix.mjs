// Lifestyle-verified pos-1 correction. Reads lifestyle-pos1-plan.json.
//  - swap : move the clean lifestyle image (matched by URL) to position 1.
//  - untag: remove the "lifestyle-verified" tag (products with no clean lifestyle anywhere).
// Dry-run by default (prints + CSV). Pass --apply to write. 2 req/sec, re-GET verification,
// per-item checkpoint (resume-safe). READ target theme = PROD catalog (Shopify products).
//   node scripts/lifestyle-pos1-fix.mjs            # dry-run
//   node scripts/lifestyle-pos1-fix.mjs --apply    # execute
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); env[m[1]] = v; } return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const TAG = "lifestyle-verified";
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let last = 0;
async function api(path, opts = {}) {
  for (let a = 0; a < 6; a++) {
    const w = 500 - (Date.now() - last); if (w > 0) await sleep(w); last = Date.now();
    const res = await fetch(`https://${STORE}/admin/api/${API}${path}`, { ...opts, headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) } });
    if (res.status === 429) { await sleep(Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 10) * 1000); continue; }
    if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
  throw new Error(`${path} failed after 429 retries`);
}
const getImages = async (id) => ((await api(`/products/${id}/images.json`)).images || []).slice().sort((a, b) => a.position - b.position);
const stem = (src) => (src || "").split("?")[0];

const plan = JSON.parse(readFileSync(new URL("../lifestyle-pos1-plan.json", import.meta.url), "utf8"));
const CK = new URL("../lifestyle-pos1-fix.checkpoint.jsonl", import.meta.url);
const done = new Set();
if (existsSync(CK)) for (const l of readFileSync(CK, "utf8").split(/\r?\n/)) { if (!l.trim()) continue; try { const o = JSON.parse(l); if (o.ok) done.add(o.key); } catch {} }

const csv = [["action", "id", "handle", "detail_before", "detail_after", "status"].join(",")];
const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
let swapOk = 0, untagOk = 0, skipped = 0, failed = 0;

console.log(`MODE: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"} | swaps=${plan.swaps.length} untags=${plan.untags.length}\n`);

// ---- SWAPS ----
for (const s of plan.swaps) {
  const key = `swap:${s.id}`;
  if (done.has(key)) { console.log(`  [skip done] ${s.handle}`); skipped++; continue; }
  try {
    const imgs = await getImages(s.id);
    const cur = imgs.find(i => i.position === 1);
    const target = imgs.find(i => stem(i.src) === s.target_url);
    if (!target) throw new Error(`target image not found (${s.target_url})`);
    const before = `pos1=img${cur?.id}(${stem(cur?.src).split("/").pop()})`;
    const after = `pos1<-img${target.id}(pos${target.position}, ${stem(target.src).split("/").pop()})`;
    if (target.position === 1) { console.log(`  [already pos1] ${s.handle}`); csv.push(["swap", s.id, s.handle, before, after, "ALREADY_POS1"].map(cell).join(",")); skipped++; continue; }
    if (!APPLY) {
      console.log(`  [swap] ${s.handle}\n     ${before}  ->  ${after}`);
      csv.push(["swap", s.id, s.handle, before, after, "DRY_RUN"].map(cell).join(","));
    } else {
      await api(`/products/${s.id}/images/${target.id}.json`, { method: "PUT", body: JSON.stringify({ image: { id: target.id, position: 1 } }) });
      const after2 = await getImages(s.id);
      const nowPos1 = after2.find(i => i.position === 1);
      const verified = nowPos1 && String(nowPos1.id) === String(target.id);
      console.log(`  [swap ${verified ? "OK" : "VERIFY-FAIL"}] ${s.handle} -> pos1 now img${nowPos1?.id}`);
      csv.push(["swap", s.id, s.handle, before, after, verified ? "APPLIED_VERIFIED" : "APPLIED_UNVERIFIED"].map(cell).join(","));
      appendFileSync(CK, JSON.stringify({ key, ok: verified, id: s.id, handle: s.handle, target_image_id: target.id, verified }) + "\n");
      verified ? swapOk++ : failed++;
    }
  } catch (e) { console.log(`  [swap FAIL] ${s.handle}: ${e.message}`); csv.push(["swap", s.id, s.handle, "", "", "ERROR:" + e.message].map(cell).join(",")); failed++; }
}

// ---- UNTAGS ----
for (const u of plan.untags) {
  const key = `untag:${u.id}`;
  if (done.has(key)) { console.log(`  [skip done] untag ${u.handle}`); skipped++; continue; }
  try {
    const p = (await api(`/products/${u.id}.json?fields=id,tags`)).product;
    const tags = (p.tags || "").split(",").map(t => t.trim()).filter(Boolean);
    const newTags = tags.filter(t => t.toLowerCase() !== TAG);
    const before = tags.join(", "), after = newTags.join(", ");
    if (tags.length === newTags.length) { console.log(`  [tag absent] ${u.handle}`); csv.push(["untag", u.id, u.handle, before, after, "TAG_ABSENT"].map(cell).join(",")); skipped++; continue; }
    if (!APPLY) {
      console.log(`  [untag] ${u.handle}\n     removes "${TAG}" (${tags.length} -> ${newTags.length} tags)`);
      csv.push(["untag", u.id, u.handle, before, after, "DRY_RUN"].map(cell).join(","));
    } else {
      await api(`/products/${u.id}.json`, { method: "PUT", body: JSON.stringify({ product: { id: Number(u.id), tags: newTags.join(", ") } }) });
      const chk = (await api(`/products/${u.id}.json?fields=id,tags`)).product;
      const stillHas = (chk.tags || "").split(",").map(t => t.trim().toLowerCase()).includes(TAG);
      console.log(`  [untag ${!stillHas ? "OK" : "VERIFY-FAIL"}] ${u.handle}`);
      csv.push(["untag", u.id, u.handle, before, after, !stillHas ? "APPLIED_VERIFIED" : "APPLIED_UNVERIFIED"].map(cell).join(","));
      appendFileSync(CK, JSON.stringify({ key, ok: !stillHas, id: u.id, handle: u.handle }) + "\n");
      !stillHas ? untagOk++ : failed++;
    }
  } catch (e) { console.log(`  [untag FAIL] ${u.handle}: ${e.message}`); csv.push(["untag", u.id, u.handle, "", "", "ERROR:" + e.message].map(cell).join(",")); failed++; }
}

writeFileSync(new URL("../lifestyle-pos1-fix.dryrun.csv", import.meta.url), csv.join("\n"));
console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} DONE. swapOk=${swapOk} untagOk=${untagOk} skipped=${skipped} failed=${failed}. CSV: lifestyle-pos1-fix.dryrun.csv`);
if (failed) process.exitCode = 1;
