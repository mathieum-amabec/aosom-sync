#!/usr/bin/env node
// scripts/fix-bilingual-content.js
// Fix 101 products whose Shopify body_html is the raw Aosom English description
// instead of the Claude-generated French description.
//
// Root cause: products were imported via Shopify CSV before the bilingual pipeline
// existed. The French description was never pushed to body_html.
//
// Two groups:
//   Group A (7 products):  FR content saved in import_jobs.content.descriptionFr
//                          → restore directly, no Claude call needed
//   Group B (94 products): no FR saved anywhere
//                          → translate custom.body_html_en metafield via Claude
//
// Usage:
//   node scripts/fix-bilingual-content.js           # dry run (default)
//   node scripts/fix-bilingual-content.js --execute  # apply changes
//
// Requires SHOPIFY_ACCESS_TOKEN, ANTHROPIC_API_KEY, TURSO_DATABASE_URL,
// TURSO_AUTH_TOKEN in .env.local or environment.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── env loading ─────────────────────────────────────────────────────
function loadDotenv() {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotenv();

const DRY_RUN = !process.argv.includes("--execute");
const STORE = "27u5y2-kp.myshopify.com";
const API_VERSION = "2024-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TOKEN) { console.error("ERROR: SHOPIFY_ACCESS_TOKEN not set"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("ERROR: ANTHROPIC_API_KEY not set"); process.exit(1); }
if (!TURSO_URL || !TURSO_TOKEN) { console.error("ERROR: TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set"); process.exit(1); }

const CLAUDE_MODEL = "claude-sonnet-4-20250514";

// ─── helpers ─────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const FR_WORDS = new Set(["le","la","les","de","du","des","est","avec","pour","une","sur","par","qui","que","cette","son","notre","votre","ajoutez","cette","idéal","parfait","confort"]);
const EN_WORDS = new Set(["the","this","with","for","your","from","features","set","our","you","perfect","includes","transform","outdoor","indoor","great","ideal","design","style","allows","provides","ensure"]);

function detectLang(html) {
  const text = html.replace(/<[^>]+>/g, " ").toLowerCase();
  const words = text.split(/\s+/).slice(0, 80);
  const fr = words.filter(w => FR_WORDS.has(w)).length;
  const en = words.filter(w => EN_WORDS.has(w)).length;
  if (fr > en) return "FR";
  if (en > fr) return "EN";
  return "UNKNOWN";
}

// ─── Shopify helpers ─────────────────────────────────────────────────
async function shopifyFetch(urlOrPath, opts = {}) {
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : `https://${STORE}/admin/api/${API_VERSION}${urlOrPath}`;

  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": TOKEN,
      ...(opts.headers || {}),
    },
  });

  if (res.status === 429) {
    const wait = Math.min(parseFloat(res.headers.get("Retry-After") || "2"), 30);
    await sleep(wait * 1000);
    return shopifyFetch(urlOrPath, opts);
  }

  return res;
}

async function fetchAllProducts() {
  const products = [];
  let nextUrl = `/products.json?limit=250&fields=id,title,body_html&status=active,draft`;

  while (nextUrl) {
    const res = await shopifyFetch(nextUrl);
    if (!res.ok) throw new Error(`Shopify fetch failed: ${res.status}`);
    const data = await res.json();
    for (const p of data.products) {
      products.push({ id: String(p.id), title: p.title || "", body_html: p.body_html || "" });
    }
    const link = res.headers.get("Link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = m ? m[1] : null;
    if (nextUrl) await sleep(400);
  }

  return products;
}

async function fetchMetafield(productId, key) {
  const res = await shopifyFetch(`/products/${productId}/metafields.json?namespace=custom&key=${key}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.metafields?.[0]?.value || null;
}

async function updateBodyHtml(productId, bodyHtml) {
  const res = await shopifyFetch(`/products/${productId}.json`, {
    method: "PUT",
    body: JSON.stringify({ product: { id: productId, body_html: bodyHtml } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT failed: ${res.status} — ${text.slice(0, 200)}`);
  }
}

// ─── Claude helpers ───────────────────────────────────────────────────
async function generateFrench(titleFr, bodyHtmlEn) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const msg = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: `You are a bilingual e-commerce copywriter for the Quebec/Canada market.
Translate the given English product description HTML to Canadian French (Quebec French).

Rules:
- Keep ALL HTML tags and structure intact (same elements, same nesting)
- Use natural Quebec French — not Parisian French
- Metric units only (already in the EN text)
- Do NOT include the product title or price in the description
- Return ONLY the translated HTML — no markdown fences, no explanations`,
    messages: [
      {
        role: "user",
        content: `Product title (for context only, do NOT include in output): ${titleFr}\n\nTranslate this HTML to Quebec French:\n${bodyHtmlEn}`,
      },
    ],
  });

  const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  if (!text) throw new Error("Claude returned empty response");
  // Strip accidental markdown fences
  return text.replace(/^```html?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
}

// ─── Turso helpers ────────────────────────────────────────────────────
async function loadImportJobsFrContent() {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  const result = await db.execute(
    "SELECT shopify_id, content FROM import_jobs WHERE shopify_id IS NOT NULL AND content IS NOT NULL"
  );

  const map = new Map();
  for (const row of result.rows) {
    try {
      const content = JSON.parse(row.content);
      if (content.descriptionFr && detectLang(content.descriptionFr) === "FR") {
        map.set(String(row.shopify_id), content.descriptionFr);
      }
    } catch {
      // skip malformed rows
    }
  }
  return map;
}

// ─── main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(DRY_RUN
    ? "DRY RUN — no changes will be made. Pass --execute to apply."
    : "EXECUTE MODE — changes will be applied to Shopify."
  );

  console.log("\n[1/4] Fetching all Shopify products...");
  const all = await fetchAllProducts();
  const broken = all.filter(p => detectLang(p.body_html) === "EN");
  console.log(`      ${all.length} total, ${broken.length} with English body_html`);

  console.log("\n[2/4] Loading saved French content from import_jobs...");
  const savedFr = await loadImportJobsFrContent();

  const groupA = broken.filter(p => savedFr.has(p.id));
  const groupB = broken.filter(p => !savedFr.has(p.id));

  console.log(`      Group A (restore from DB, no Claude): ${groupA.length}`);
  console.log(`      Group B (generate via Claude):        ${groupB.length}`);
  if (!DRY_RUN) {
    console.log(`      Estimated time: ~${Math.ceil(groupB.length * 3.5 / 60)} min for Group B`);
  }

  let fixed = 0, skipped = 0, errors = 0;

  // ── Group A ──────────────────────────────────────────────────────────
  console.log("\n[3/4] Group A — restoring saved descriptionFr...");
  for (const p of groupA) {
    const descFr = savedFr.get(p.id);
    console.log(`[FIX-BILINGUAL] ${p.id} "${p.title.slice(0, 55)}" — Group A: restore from DB`);

    if (DRY_RUN) {
      console.log(`  → would set body_html to saved descriptionFr (${descFr.length} chars)`);
    } else {
      try {
        await updateBodyHtml(p.id, descFr);
        console.log(`  ✅ Updated`);
        fixed++;
      } catch (e) {
        console.error(`  ❌ Error: ${e.message}`);
        errors++;
      }
      await sleep(1000);
    }
  }

  // ── Group B ──────────────────────────────────────────────────────────
  console.log("\n[4/4] Group B — generating French via Claude...");
  for (let i = 0; i < groupB.length; i++) {
    const p = groupB[i];
    const progress = `[${i + 1}/${groupB.length}]`;
    console.log(`[FIX-BILINGUAL] ${progress} ${p.id} "${p.title.slice(0, 55)}" — Group B: generate FR`);

    if (DRY_RUN) {
      console.log(`  → would fetch body_html_en metafield and generate French via Claude`);
    } else {
      try {
        // Fetch EN metafield
        const enHtml = await fetchMetafield(p.id, "body_html_en");
        await sleep(500);

        if (!enHtml) {
          console.log(`  ⚠️  No body_html_en metafield found — skipping`);
          skipped++;
          continue;
        }

        // Generate FR via Claude
        const frHtml = await generateFrench(p.title, enHtml);
        await sleep(2000); // 2s between Claude calls

        // Verify it's actually French before pushing
        if (detectLang(frHtml) !== "FR") {
          console.error(`  ⚠️  Claude returned non-French content — skipping (manual review needed)`);
          skipped++;
          continue;
        }

        // Push to Shopify
        await updateBodyHtml(p.id, frHtml);
        await sleep(1000);

        console.log(`  ✅ Generated (${frHtml.length} chars) and updated`);
        fixed++;
      } catch (e) {
        console.error(`  ❌ Error: ${e.message}`);
        errors++;
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("════════════════════════════════════════");
  if (DRY_RUN) {
    console.log(`Total broken:  ${broken.length}`);
    console.log(`Group A (DB):  ${groupA.length} — instant, no API cost`);
    console.log(`Group B (AI):  ${groupB.length} — ~${Math.ceil(groupB.length * 3.5 / 60)} min, ~${groupB.length} Claude calls`);
    console.log(`\nRun with --execute to apply changes.`);
  } else {
    console.log(`Fixed:   ${fixed} / ${broken.length}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Errors:  ${errors}`);
    if (errors > 0) console.log(`\nCheck error output above. Re-run --execute to retry (already-fixed products will be skipped).`);
  }
}

main().catch(e => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
