/**
 * audit-description-language — READ-ONLY. Counts active Shopify products whose
 * customer-facing description is not French, and which ones leak a supplier name.
 *
 * This is the script behind the figures quoted in CHANGELOG v0.5.92.3, CLAUDE.md and
 * the architectural comment in src/lib/diff-engine.ts. Re-run it to re-measure rather
 * than trusting a number that was true on one day.
 *
 * Background: from b497260 (2026-04-05) to v0.5.92.3, the Phase-2 Shopify push compared
 * the Aosom feed's ENGLISH `description` against the curated FRENCH `body_html` and wrote
 * the feed copy over it. Measured 2026-09-11: 679 of 1382 active products (49%) English,
 * 518 leaking a supplier name.
 *
 * Usage (x64 Node on Windows ARM, prod creds):
 *   node --env-file=.env.local scripts/audit-description-language.mjs
 *   node --env-file=.env.local scripts/audit-description-language.mjs --json out.json
 *
 * Requires SHOPIFY_ACCESS_TOKEN. TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are optional and
 * only used to report how many bodies are byte-identical to today's feed description.
 * Never writes to Shopify or Turso.
 */
import fs from "node:fs";

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const jsonIdx = process.argv.indexOf("--json");
const JSON_OUT = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : null;

if (!TOKEN) {
  console.error("SHOPIFY_ACCESS_TOKEN is required");
  process.exit(1);
}

/**
 * FR/EN detector. Counts language-specific function words, which are frequent enough in
 * any real product description to separate the two decisively. Validated 2026-09-11 on
 * all 1382 active products: 703 FR, 679 EN, zero MIXED, zero empty.
 */
const FR_WORDS =
  /\b(vous|votre|vos|avec|pour|cette|cet|une|des|les|est|sont|plus|sans|dans|qui|que|aux|par|sur|peut|tout|toute)\b/g;
const FR_ACCENTED = /\b(très|déjà|qualité|matériau|conçu|résistant)\b/g;
const EN_WORDS =
  /\b(you|your|with|for|this|the|and|are|is|from|its|features|specification|includes|provides|easy|design|made)\b/g;

export function detectDescriptionLanguage(html) {
  const text = (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const fr = (text.match(FR_WORDS) || []).length + (text.match(FR_ACCENTED) || []).length;
  const en = (text.match(EN_WORDS) || []).length;
  if (fr === 0 && en === 0) return { fr, en, lang: "empty" };
  if (en > fr * 1.5) return { fr, en, lang: "EN" };
  if (fr > en * 1.5) return { fr, en, lang: "FR" };
  return { fr, en, lang: "MIXED" };
}

/** Supplier names that must never reach customer-facing copy. */
export const FORBIDDEN_SUPPLIERS = /\b(aosom|outsunny|homcom|qaba|pawhut|vinsetto|soozier|durhand)\b/gi;
export const suppliersIn = (html) => [...new Set((html || "").match(FORBIDDEN_SUPPLIERS)?.map((s) => s.toLowerCase()) ?? [])];

let lastReq = 0;
async function shopifyGet(url) {
  const wait = 560 - (Date.now() - lastReq); // Shopify Admin API: <= 2 req/sec
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 4000));
    return shopifyGet(url);
  }
  if (!res.ok) throw new Error(`Shopify ${res.status} on ${url}`);
  return { json: await res.json(), link: res.headers.get("link") || "" };
}

async function fetchActiveProducts() {
  let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,title,handle,body_html,status,variants`;
  const out = [];
  while (url) {
    const { json, link } = await shopifyGet(url);
    for (const p of json.products || []) {
      if (p.status !== "active") continue;
      out.push({
        id: String(p.id),
        title: p.title,
        handle: p.handle,
        bodyHtml: p.body_html || "",
        skus: (p.variants || []).map((v) => v.sku).filter(Boolean),
      });
    }
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
    process.stderr.write(`  fetched ${out.length} active products\n`);
  }
  return out;
}

/** Optional: today's feed description per SKU, to flag bodies that ARE the raw feed. */
async function fetchFeedDescriptions() {
  const dbUrl = (process.env.TURSO_DATABASE_URL || "").replace(/^libsql:\/\//, "https://");
  if (!dbUrl || !process.env.TURSO_AUTH_TOKEN) return null;
  const res = await fetch(`${dbUrl}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TURSO_AUTH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql: "SELECT sku, description FROM products WHERE description IS NOT NULL AND description != ''" } },
        { type: "close" },
      ],
    }),
  });
  const body = await res.json();
  const result = body.results?.[0];
  if (result?.type !== "ok") return null;
  const cols = result.response.result.cols.map((c) => c.name);
  const map = new Map();
  for (const row of result.response.result.rows) {
    const o = Object.fromEntries(row.map((c, i) => [cols[i], c.value ?? null]));
    map.set(o.sku, o.description);
  }
  return map;
}

const normalize = (h) => (h || "").replace(/\s+/g, " ").replace(/>\s+</g, "><").trim().toLowerCase();

const products = await fetchActiveProducts();
const feed = await fetchFeedDescriptions();

const byLang = { FR: [], EN: [], MIXED: [], empty: [] };
const leaking = [];
let rawFeedCopies = 0;

for (const p of products) {
  const { lang } = detectDescriptionLanguage(p.bodyHtml);
  byLang[lang].push(p);
  const leaks = suppliersIn(p.bodyHtml);
  if (leaks.length) leaking.push({ ...p, leaks });
  if (feed) {
    const feedRow = p.skus.map((s) => feed.get(s)).find(Boolean);
    if (feedRow && normalize(p.bodyHtml) === normalize(feedRow)) rawFeedCopies++;
  }
}

const total = products.length;
const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : "0.0");

console.log(`
=============== DESCRIPTION LANGUAGE AUDIT (read-only) ===============
Active products ................................. ${total}
  French .......................................  ${byLang.FR.length} (${pct(byLang.FR.length)}%)
  ENGLISH ......................................  ${byLang.EN.length} (${pct(byLang.EN.length)}%)
  mixed / undetermined .........................  ${byLang.MIXED.length}
  empty description ............................  ${byLang.empty.length}
${feed ? `  body identical to today's feed description ...  ${rawFeedCopies}` : "  (Turso creds absent — skipped the raw-feed comparison)"}

Leaking a forbidden supplier name ............... ${leaking.length} (${pct(leaking.length)}%)
======================================================================`);

if (byLang.EN.length) {
  console.log(`\nFirst 25 English descriptions:`);
  byLang.EN.slice(0, 25).forEach((p) => console.log(`  ${(p.skus[0] || "").padEnd(14)} ${p.title.slice(0, 60)}`));
}
if (byLang.MIXED.length) {
  console.log(`\nMIXED (detector could not decide) — review these by hand:`);
  byLang.MIXED.forEach((p) => console.log(`  ${(p.skus[0] || "").padEnd(14)} ${p.title.slice(0, 60)}`));
}

if (JSON_OUT) {
  const slim = (p) => ({ id: p.id, sku: p.skus[0] || "", handle: p.handle, title: p.title });
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        totalActive: total,
        french: byLang.FR.length,
        english: byLang.EN.length,
        mixed: byLang.MIXED.length,
        empty: byLang.empty.length,
        rawFeedCopies: feed ? rawFeedCopies : null,
        leakingSupplierName: leaking.length,
        englishProducts: byLang.EN.map(slim),
        leakingProducts: leaking.map((p) => ({ ...slim(p), leaks: p.leaks })),
      },
      null,
      2
    )
  );
  console.log(`\nJSON written to ${JSON_OUT}`);
}
