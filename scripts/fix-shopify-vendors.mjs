/**
 * Debrand Shopify product vendors → "Ameublo Direct".
 *
 * All catalogue products carry a supplier vendor (Aosom, Qaba, Soozier, Outsunny…).
 * This rewrites every product's `vendor` to the store brand so no supplier name
 * leaks via the Shopify vendor field (analytics meta, feeds, etc.).
 *
 * Usage:
 *   node scripts/fix-shopify-vendors.mjs            # DRY-RUN (no writes) — default
 *   node scripts/fix-shopify-vendors.mjs --apply    # execute the PUTs
 *
 * Requires SHOPIFY_ACCESS_TOKEN in the environment.
 * Rate limit: 2 req/sec strict (>=500ms between every API call).
 */
const STORE = "27u5y2-kp.myshopify.com";
const API = "2024-01";
const TARGET = "Ameublo Direct";
const RL_MS = 500; // 2 req/sec strict

const APPLY = process.argv.includes("--apply");
const token = process.env.SHOPIFY_ACCESS_TOKEN;
if (!token) {
  console.error("ERROR: SHOPIFY_ACCESS_TOKEN not set");
  process.exit(1);
}
const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paginate every product (id, title, vendor) via the Link header cursor. */
async function fetchAllProducts() {
  const out = [];
  let url = `https://${STORE}/admin/api/${API}/products.json?fields=id,title,vendor&limit=250`;
  while (url) {
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error(`list HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    out.push(...data.products);
    const m = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    await sleep(RL_MS);
  }
  return out;
}

/** PUT one product's vendor. Honors 429 retry-after (capped); throws on other non-2xx. */
const MAX_429_RETRIES = 6;
async function setVendor(id) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${STORE}/admin/api/${API}/products/${id}.json`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ product: { id, vendor: TARGET } }),
    });
    if (r.status === 429) {
      if (attempt >= MAX_429_RETRIES) throw new Error(`PUT ${id}: rate-limited after ${attempt} retries`);
      const ra = Number(r.headers.get("retry-after")) || 2;
      await sleep(ra * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`PUT ${id} HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return;
  }
}

const products = await fetchAllProducts();
const tally = {};
for (const p of products) {
  const v = (p.vendor ?? "").trim() || "(empty)";
  tally[v] = (tally[v] || 0) + 1;
}
const toChange = products.filter((p) => (p.vendor ?? "").trim() !== TARGET);

console.log(`Mode            : ${APPLY ? "APPLY (writes to Shopify)" : "DRY-RUN (no writes)"}`);
console.log(`Total produits  : ${products.length}`);
console.log(`Vendors actuels :`);
for (const [v, c] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(5)}  ${v}`);
}
console.log(`À débrander → "${TARGET}" : ${toChange.length}  (déjà conformes : ${products.length - toChange.length})`);

if (!APPLY) {
  console.log(`\n[DRY-RUN] Aperçu (10 premiers) :`);
  for (const p of toChange.slice(0, 10)) {
    console.log(`  #${p.id}  "${p.vendor}" → "${TARGET}"  | ${(p.title || "").slice(0, 50)}`);
  }
  console.log(`\nDry-run terminé. ${toChange.length} produits seraient modifiés. Relancer avec --apply pour exécuter.`);
  process.exit(0);
}

// --apply
console.log(`\nApplication sur ${toChange.length} produits (≥${RL_MS}ms entre chaque appel)…`);
let ok = 0, fail = 0;
for (let i = 0; i < toChange.length; i++) {
  const p = toChange[i];
  try {
    await setVendor(p.id);
    ok++;
    console.log(`[${i + 1}/${toChange.length}] #${p.id}  "${p.vendor}" → "${TARGET}"`);
  } catch (e) {
    fail++;
    console.error(`[${i + 1}/${toChange.length}] #${p.id} ÉCHEC : ${e.message}`);
  }
  await sleep(RL_MS);
}
console.log(`\nApply terminé. OK : ${ok}, échecs : ${fail}.`);
process.exit(fail ? 1 : 0);
