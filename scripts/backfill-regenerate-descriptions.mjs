#!/usr/bin/env node --env-file=.env.local
/**
 * Regenerates body_html for active Shopify products whose description is
 * English AND has no recoverable archived French version in import_jobs
 * (scripts/backfill-restore-french-descriptions.mjs handles the recoverable
 * ones). Calls the real generateProductContent() (src/lib/content-generator.ts)
 * — the same function the live import pipeline uses — which as of
 * fix/catalog-content-guard (PR #474) strips supplier brands from descriptions
 * too and throws/retries on a non-French descriptionFr, so this reuses the
 * write-time guard rather than duplicating its logic.
 *
 * Only writes body_html + custom.body_html_en. Title, meta fields, and the URL
 * handle are left untouched (same scope boundary as the restore script) — this
 * is a description fix, not a full re-import.
 *
 * Checkpointed like the restore script: --apply resumes past products already
 * recorded "ok".
 *
 * Usage (x64 Node, prod creds, run from repo root so @/ resolves):
 *   node --env-file=.env.local scripts/backfill-regenerate-descriptions.mjs           # dry run (lists candidates, no LLM calls)
 *   node --env-file=.env.local scripts/backfill-regenerate-descriptions.mjs --apply   # generate + write
 */
import fs from "node:fs";
import { createClient } from "@libsql/client";
// tsx's ESM/CJS interop under this repo's tsconfig (module: esnext, moduleResolution:
// bundler) only reliably exposes the whole CJS exports object as `default` when running
// via `node --import tsx` with a .mjs entry — named-export static detection misses it
// even for a trivial one-export file. Default-import + destructure sidesteps that.
import contentGeneratorModule from "../src/lib/content-generator.ts";
const { generateProductContent } = contentGeneratorModule;

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
if (!TOKEN) { console.error("SHOPIFY_ACCESS_TOKEN required"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const CHECKPOINT_FILE = ".tmp-invest/task-a-regen-checkpoint.jsonl";

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

// extractBrand — ported from src/lib/csv-fetcher.ts (not exported there).
const KNOWN_BRANDS = ["Outsunny", "HomCom", "HOMCOM", "PawHut", "Soozier", "Vinsetto", "Aosom", "Qaba", "ShopEZ", "Wikinger", "Portland", "Aousthop"];
function extractBrand(name) {
  if (!name) return "Aosom";
  const nameLower = name.toLowerCase();
  for (const brand of KNOWN_BRANDS) if (nameLower.startsWith(brand.toLowerCase())) return brand;
  return "Aosom";
}

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
  let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,title,handle,body_html,status,variants`;
  const out = [];
  while (url) {
    const res = await shopifyReq(url);
    const link = res.headers.get("link") || "";
    const json = await res.json();
    for (const p of json.products || []) {
      if (p.status === "active") out.push({ id: String(p.id), title: p.title, handle: p.handle, bodyHtml: p.body_html || "", skus: (p.variants || []).map((v) => v.sku).filter(Boolean) });
    }
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
    process.stderr.write(`  fetched ${out.length} active products\n`);
  }
  return out;
}

async function fetchImportJobShopifyIds(client) {
  const rows = await client.execute({ sql: `SELECT shopify_id, content FROM import_jobs WHERE shopify_id IS NOT NULL AND content IS NOT NULL AND content != ''`, args: [] });
  const set = new Set();
  for (const r of rows.rows) {
    try {
      const parsed = JSON.parse(r.content);
      if (typeof parsed.descriptionFr === "string" && parsed.descriptionFr.trim()) set.add(String(r.shopify_id));
    } catch {}
  }
  return set;
}

async function fetchMergedProduct(client, skus) {
  const rows = await client.execute({
    sql: `SELECT sku, name, price, product_type, material, description, short_description FROM products WHERE sku IN (${skus.map(() => "?").join(",")})`,
    args: skus,
  });
  if (rows.rows.length === 0) return null;
  const primary = rows.rows[0];
  return {
    name: primary.name || "",
    description: primary.description || "",
    shortDescription: primary.short_description || "",
    brand: extractBrand(primary.name || ""),
    productType: primary.product_type || "",
    category: "",
    material: primary.material || "",
    variants: rows.rows.map((r) => ({ sku: r.sku, price: r.price || 0 })),
  };
}

async function fetchMetafieldId(id) {
  const res = await shopifyReq(`https://${STORE}/admin/api/${API}/products/${id}/metafields.json?namespace=custom&key=body_html_en`);
  const json = await res.json();
  return json.metafields?.[0]?.id ?? null;
}

const client = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const products = await fetchActiveProducts();
const recoverableIds = await fetchImportJobShopifyIds(client);

const candidates = products.filter((p) => detectLang(p.bodyHtml) === "EN" && !recoverableIds.has(p.id));

console.log(`\n=============== REGENERATE DESCRIPTIONS (${APPLY ? "APPLY" : "DRY RUN"}) ===============`);
console.log(`Active products: ${products.length}`);
console.log(`English + not recoverable (candidates): ${candidates.length}`);

if (!APPLY) {
  candidates.forEach((c) => console.log(`  ${c.id} ${c.handle}`));
  console.log("\nDry run only — pass --apply to generate + write.");
  process.exit(0);
}

const alreadyDone = new Set();
if (fs.existsSync(CHECKPOINT_FILE)) {
  for (const line of fs.readFileSync(CHECKPOINT_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const rec = JSON.parse(line); if (rec.status === "ok") alreadyDone.add(rec.id); } catch {}
  }
  console.log(`Checkpoint found: ${alreadyDone.size} already regenerated, will be skipped.`);
}

const logStream = fs.createWriteStream(CHECKPOINT_FILE, { flags: "a" });
let ok = 0, failed = 0, skipped = 0;
for (const p of candidates) {
  if (alreadyDone.has(p.id)) { skipped++; continue; }
  try {
    const merged = await fetchMergedProduct(client, p.skus);
    if (!merged) throw new Error("no Turso rows found for this product's SKUs");

    const content = await generateProductContent(merged);

    const bodyRes = await shopifyReq(`https://${STORE}/admin/api/${API}/products/${p.id}.json`, {
      method: "PUT",
      body: JSON.stringify({ product: { id: p.id, body_html: content.descriptionFr } }),
    });
    if (!bodyRes.ok) throw new Error(`body_html PUT failed: ${bodyRes.status} ${(await bodyRes.text()).slice(0, 200)}`);

    const metafieldId = await fetchMetafieldId(p.id);
    const metaBody = metafieldId
      ? { metafield: { id: metafieldId, value: content.descriptionEn, type: "multi_line_text_field" } }
      : { metafield: { namespace: "custom", key: "body_html_en", value: content.descriptionEn, type: "multi_line_text_field" } };
    const metaRes = await shopifyReq(
      metafieldId ? `https://${STORE}/admin/api/${API}/metafields/${metafieldId}.json` : `https://${STORE}/admin/api/${API}/products/${p.id}/metafields.json`,
      { method: metafieldId ? "PUT" : "POST", body: JSON.stringify(metaBody) },
    );
    if (!metaRes.ok) console.error(`  WARN ${p.id} ${p.handle}: body_html_en metafield write failed (${metaRes.status}) — body_html itself succeeded`);

    ok++;
    logStream.write(JSON.stringify({ id: p.id, handle: p.handle, status: "ok", ts: Date.now() }) + "\n");
    console.log(`OK ${p.id} ${p.handle}`);
  } catch (err) {
    failed++;
    logStream.write(JSON.stringify({ id: p.id, handle: p.handle, status: "failed", error: String(err instanceof Error ? err.message : err), ts: Date.now() }) + "\n");
    console.error(`FAILED ${p.id} ${p.handle}: ${err instanceof Error ? err.message : err}`);
  }
}
logStream.end();
console.log(`\nDone. ok=${ok} failed=${failed} skipped(already done)=${skipped}`);
