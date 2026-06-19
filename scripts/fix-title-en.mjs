#!/usr/bin/env node
/**
 * One-off de-brand of the 6 known `custom.title_en` metafields that still start
 * with the supplier brand "Outsunny ". The matching FR titles were already
 * de-branded; only these EN metafields kept the leading brand. See the title-EN
 * migration audit (638 products scanned, 6 offenders, all "Outsunny" prefix).
 *
 * Dry-run by default (prints before/after). Pass --apply to write.
 * Run under node-x64. SHOPIFY_ACCESS_TOKEN passed via env.
 *
 *   node scripts/fix-title-en.mjs           # dry-run
 *   node scripts/fix-title-en.mjs --apply   # write
 */

const STORE = "27u5y2-kp.myshopify.com";
// Match the rest of the app (shopify-client.ts → SHOPIFY.API_VERSION). The
// metafields REST shape is identical on 2024-01; 2025-01 is what we ship.
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("missing SHOPIFY_ACCESS_TOKEN");
  process.exit(1);
}

const APPLY = process.argv.includes("--apply");

// The exact 6 product IDs from the audit — no pagination needed.
const IDS = [
  "7736576901225",
  "7736568971369",
  "7736571494505",
  "7736571592809",
  "7736577228905",
  "7736547475561",
];

const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN };
const base = `https://${STORE}/admin/api/${API}`;

async function req(url, init) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers, ...init });
    if (r.status === 429) {
      const wait = parseFloat(r.headers.get("Retry-After") || "2");
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} on ${url}: ${await r.text()}`);
    return r;
  }
  throw new Error(`rate-limited out: ${url}`);
}

// Strip a leading "Outsunny " (case-insensitive, tolerant of extra spaces).
function debrand(s) {
  return s.replace(/^\s*Outsunny\s+/i, "").trim();
}

console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

let changed = 0;
let skipped = 0;

for (const id of IDS) {
  const r = await req(`${base}/products/${id}/metafields.json?namespace=custom&key=title_en`);
  const { metafields } = await r.json();
  const mf = (metafields || []).find((m) => m.namespace === "custom" && m.key === "title_en");

  if (!mf) {
    console.log(`[${id}] ⚠ no custom.title_en metafield — SKIP`);
    skipped++;
    continue;
  }

  const before = mf.value;
  const after = debrand(before);

  if (before === after) {
    console.log(`[${id}] no leading "Outsunny" — SKIP\n        EN: ${before}`);
    skipped++;
    continue;
  }

  // Guard: never write a blank title_en (Shopify 422s on an empty
  // single_line_text_field, and an empty EN title is worse than a branded one).
  if (after === "") {
    console.log(`[${id}] ⚠ de-brand would empty the title — SKIP\n        EN: ${before}`);
    skipped++;
    continue;
  }

  console.log(`[${id}] mf=${mf.id}`);
  console.log(`        before: ${before}`);
  console.log(`        after:  ${after}`);

  if (APPLY) {
    await req(`${base}/products/${id}/metafields/${mf.id}.json`, {
      method: "PUT",
      body: JSON.stringify({ metafield: { id: mf.id, value: after, type: mf.type } }),
    });
    console.log(`        ✓ written`);
  }
  changed++;
  console.log("");
}

console.log(`\n=== SUMMARY ===`);
console.log(`would change: ${changed}`);
console.log(`skipped:      ${skipped}`);
console.log(APPLY ? "Applied." : "Dry-run only. Re-run with --apply to write.");
