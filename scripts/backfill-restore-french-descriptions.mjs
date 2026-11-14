/**
 * Restores body_html for active Shopify products whose description was flipped to
 * raw English by the (since-fixed, v0.5.92.3) diff-engine bug, using the curated
 * French text archived in import_jobs.content.descriptionFr. Applies the same
 * elision-aware stripSupplierBrands() as src/lib/catalog-guard.ts (copied here —
 * see comment below — so this one-off script has no build/path-alias dependency)
 * so the restore also closes any residual supplier-brand leak in the archived
 * text itself (measured 2026-09-15: 157/568 archived descriptions still leaked).
 *
 * Only touches body_html (the FR/primary field the bug corrupted). Never touches
 * custom.body_html_en — that metafield was never written by the bug (the EN feed
 * copy only ever replaced the FR body_html field) and is presumed still correct
 * from import time.
 *
 * Checkpointed: re-running with --apply skips products already recorded "ok" in
 * the checkpoint file, so an interrupted run is safe to resume.
 *
 * Usage (x64 Node, prod creds):
 *   node --env-file=.env.local scripts/backfill-restore-french-descriptions.mjs           # dry run
 *   node --env-file=.env.local scripts/backfill-restore-french-descriptions.mjs --apply   # write
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
if (!TOKEN) { console.error("SHOPIFY_ACCESS_TOKEN required"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const CHECKPOINT_FILE = ".tmp-invest/task-a-restore-checkpoint.jsonl";

// --- FR/EN detector (ported from scripts/audit-description-language.mjs) ---
const FR_WORDS = /\b(vous|votre|vos|avec|pour|cette|cet|une|des|les|est|sont|plus|sans|dans|qui|que|aux|par|sur|peut|tout|toute)\b/g;
const FR_ACCENTED = /\b(très|déjà|qualité|matériau|conçu|résistant)\b/g;
const EN_WORDS = /\b(you|your|with|for|this|the|and|are|is|from|its|features|specification|includes|provides|easy|design|made)\b/g;
function detectLang(html) {
  const text = (html || "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").toLowerCase();
  const fr = (text.match(FR_WORDS) || []).length + (text.match(FR_ACCENTED) || []).length;
  const en = (text.match(EN_WORDS) || []).length;
  if (fr === 0 && en === 0) return "empty";
  if (en > fr * 1.5) return "EN";
  if (fr > en * 1.5) return "FR";
  return "MIXED";
}

// --- stripSupplierBrands (ported from src/lib/catalog-guard.ts — elision-aware) ---
const SUPPLIER_BRANDS = ["Outsunny", "HOMCOM", "Aosom", "Vinsetto", "PawHut", "Soozier", "Qaba", "ShopEZ", "Wikinger", "Portland", "Aousthop", "DuraHand"];
const SUPPLIER_BRAND_ALT = SUPPLIER_BRANDS.join("|");
const SUPPLIER_BRAND_RE = new RegExp(`\\b(?:${SUPPLIER_BRAND_ALT})\\b`, "gi");
const SUPPLIER_BRAND_ELIDED_RE = new RegExp(`\\b(l|d|n|s|c|j|m|t|qu)['’](?:${SUPPLIER_BRAND_ALT})\\b\\s*`, "gi");
function stripSupplierBrands(s) {
  return s
    .replace(SUPPLIER_BRAND_ELIDED_RE, "")
    .replace(SUPPLIER_BRAND_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trim();
}
const FORBIDDEN_RE = new RegExp(`\\b(?:${SUPPLIER_BRAND_ALT})\\b`, "gi");

let lastReq = 0;
async function shopifyReq(url, opts = {}) {
  const wait = 560 - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(url, { ...opts, headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 4000)); return shopifyReq(url, opts); }
  return res;
}

async function fetchActiveProducts() {
  let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,title,handle,body_html,status`;
  const out = [];
  while (url) {
    const res = await shopifyReq(url);
    const link = res.headers.get("link") || "";
    const json = await res.json();
    for (const p of json.products || []) {
      if (p.status === "active") out.push({ id: String(p.id), title: p.title, handle: p.handle, bodyHtml: p.body_html || "" });
    }
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
    process.stderr.write(`  fetched ${out.length} active products\n`);
  }
  return out;
}

async function fetchImportJobsByShopifyId(client) {
  const rows = await client.execute({
    sql: `SELECT shopify_id, content FROM import_jobs WHERE shopify_id IS NOT NULL AND content IS NOT NULL AND content != ''`,
    args: [],
  });
  const map = new Map();
  for (const r of rows.rows) map.set(String(r.shopify_id), r.content);
  return map;
}

const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const products = await fetchActiveProducts();
const jobsByShopifyId = await fetchImportJobsByShopifyId(client);

const plan = [];
let notRecoverable = 0;
for (const p of products) {
  if (detectLang(p.bodyHtml) !== "EN") continue;
  const content = jobsByShopifyId.get(p.id);
  if (!content) { notRecoverable++; continue; }
  let descriptionFr;
  try {
    const parsed = JSON.parse(content);
    descriptionFr = typeof parsed.descriptionFr === "string" ? parsed.descriptionFr : null;
  } catch {
    descriptionFr = null;
  }
  if (!descriptionFr || !descriptionFr.trim()) { notRecoverable++; continue; }
  const final = stripSupplierBrands(descriptionFr);
  plan.push({ id: p.id, handle: p.handle, title: p.title, final });
}

console.log(`\n=============== RESTORE FRENCH DESCRIPTIONS (${APPLY ? "APPLY" : "DRY RUN"}) ===============`);
console.log(`Active products: ${products.length}`);
console.log(`English body_html: ${plan.length + notRecoverable}`);
console.log(`  Recoverable (this run will restore): ${plan.length}`);
console.log(`  Not recoverable (needs regen, separate script): ${notRecoverable}`);

if (!APPLY) {
  console.log("\nDry run only — pass --apply to write these changes to Shopify.");
  process.exit(0);
}

const alreadyDone = new Set();
if (fs.existsSync(CHECKPOINT_FILE)) {
  for (const line of fs.readFileSync(CHECKPOINT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.status === "ok") alreadyDone.add(rec.id);
    } catch {}
  }
  console.log(`Checkpoint found: ${alreadyDone.size} already restored, will be skipped.`);
}

const logStream = fs.createWriteStream(CHECKPOINT_FILE, { flags: "a" });
let ok = 0, failed = 0, skipped = 0;
for (const item of plan) {
  if (alreadyDone.has(item.id)) { skipped++; continue; }
  try {
    const res = await shopifyReq(`https://${STORE}/admin/api/${API}/products/${item.id}.json`, {
      method: "PUT",
      body: JSON.stringify({ product: { id: item.id, body_html: item.final } }),
    });
    if (!res.ok) {
      const text = await res.text();
      failed++;
      logStream.write(JSON.stringify({ id: item.id, handle: item.handle, status: "failed", error: `${res.status} ${text.slice(0, 300)}`, ts: Date.now() }) + "\n");
      console.error(`FAILED ${item.id} ${item.handle}: ${res.status}`);
      continue;
    }
    ok++;
    logStream.write(JSON.stringify({ id: item.id, handle: item.handle, status: "ok", ts: Date.now() }) + "\n");
    console.log(`OK ${item.id} ${item.handle}`);
  } catch (err) {
    failed++;
    logStream.write(JSON.stringify({ id: item.id, handle: item.handle, status: "failed", error: String(err), ts: Date.now() }) + "\n");
    console.error(`ERROR ${item.id} ${item.handle}: ${err}`);
  }
}
logStream.end();
console.log(`\nDone. ok=${ok} failed=${failed} skipped(already done)=${skipped}`);
