/**
 * Debrand Shopify product descriptions (body_html).
 *
 * Aosom-sourced descriptions still leak supplier brand names (Aosom, Outsunny,
 * Qaba) inside the product body_html. This strips those tokens and tidies the
 * resulting spacing/punctuation/capitalization, then PUTs the cleaned body_html
 * back to Shopify. Pairs with the generation-time fix (content-generator) and
 * the vendor debrand — this one backfills products already live on the store.
 *
 * Usage:
 *   node scripts/fix-shopify-descriptions.mjs            # DRY-RUN (no writes) — default
 *   node scripts/fix-shopify-descriptions.mjs --apply    # execute the PUTs
 *
 * Requires SHOPIFY_ACCESS_TOKEN in the environment.
 * Rate limit: 2 req/sec strict (>=500ms between every API call).
 */
const STORE = "27u5y2-kp.myshopify.com";
const API = "2024-01";
const RL_MS = 500; // 2 req/sec strict
const EXAMPLES = 5; // before/after previews to print in dry-run

const APPLY = process.argv.includes("--apply");
const token = process.env.SHOPIFY_ACCESS_TOKEN;
if (!token) {
  console.error("ERROR: SHOPIFY_ACCESS_TOKEN not set");
  process.exit(1);
}
const H = { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Supplier tokens to scrub from body_html. \b word boundaries, case-insensitive. */
const BRAND_RE = /\b(Aosom|Outsunny|Qaba)\b/i; // detection (non-global, stateless)

/** Clean one body_html string: drop brand tokens, then tidy spacing/punctuation/caps. */
function clean(html) {
  return html
    // Drop a leading preposition together with the brand so "cat tree from Aosom,
    // rest" -> "cat tree, rest" instead of leaving a dangling "from,". Runs before
    // the generic strip, which then handles any standalone brand occurrences.
    .replace(/\b(?:from|with|by|of|avec|de|du|des|par)\s+(?:Aosom|Outsunny|Qaba)\b/gi, "")
    .replace(/\b(Aosom|Outsunny|Qaba)\b\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s([.,!?])/g, "$1")
    .replace(/(^|\.\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

/** Tag-stripped, whitespace-collapsed text — for human-readable previews only. */
function preview(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** A ±pad window of `text` centered on `idx`, with ellipses when truncated. */
function windowAt(text, idx, len, pad = 90) {
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + len + pad);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

/** Paginate every product (id, title, body_html) via the Link header cursor. */
async function fetchAllProducts() {
  const out = [];
  let url = `https://${STORE}/admin/api/${API}/products.json?fields=id,title,body_html&limit=250`;
  while (url) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) {
      const ra = Number(r.headers.get("retry-after")) || 2;
      await sleep(ra * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`list HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    out.push(...data.products);
    const m = (r.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
    await sleep(RL_MS);
  }
  return out;
}

/** PUT one product's body_html. Honors 429 retry-after (capped); throws on other non-2xx. */
const MAX_429_RETRIES = 6;
async function setBody(id, body_html) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(`https://${STORE}/admin/api/${API}/products/${id}.json`, {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ product: { id, body_html } }),
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

// Candidates: a brand token is present AND cleaning actually changes the body.
const targets = [];
for (const p of products) {
  const body = p.body_html ?? "";
  if (!body || !BRAND_RE.test(body)) continue;
  const cleaned = clean(body);
  if (cleaned !== body) targets.push({ ...p, cleaned });
}

console.log(`Mode             : ${APPLY ? "APPLY (writes to Shopify)" : "DRY-RUN (no writes)"}`);
console.log(`Total produits   : ${products.length}`);
console.log(`À débrander (Aosom/Outsunny/Qaba dans body_html) : ${targets.length}`);

if (!APPLY) {
  console.log(`\n[DRY-RUN] ${Math.min(EXAMPLES, targets.length)} exemples avant/après :`);
  for (const p of targets.slice(0, EXAMPLES)) {
    const beforeTxt = preview(p.body_html);
    const afterTxt = preview(p.cleaned);
    // Anchor on the text that FOLLOWS the brand (it survives cleaning) so the
    // before/after windows line up even when words ahead of the brand are dropped.
    const bm = beforeTxt.match(BRAND_RE);
    const bIdx = bm ? bm.index : 0;
    const tail = bm ? beforeTxt.slice(bIdx + bm[0].length).replace(/^[^A-Za-zÀ-ÿ]+/, "").slice(0, 22) : "";
    const aIdx = tail ? afterTxt.indexOf(tail) : -1;
    console.log(`\n  #${p.id}  ${(p.title || "").slice(0, 60)}`);
    console.log(`    AVANT : ${windowAt(beforeTxt, bIdx, bm ? bm[0].length : 0)}`);
    console.log(`    APRÈS : ${aIdx >= 0 ? windowAt(afterTxt, aIdx, tail.length) : afterTxt.slice(0, 180) + (afterTxt.length > 180 ? "…" : "")}`);
  }
  console.log(`\nDry-run terminé. ${targets.length} produits seraient modifiés. Relancer avec --apply pour exécuter.`);
  process.exit(0);
}

// --apply
console.log(`\nApplication sur ${targets.length} produits (≥${RL_MS}ms entre chaque appel)…`);
let ok = 0, fail = 0;
for (let i = 0; i < targets.length; i++) {
  const p = targets[i];
  try {
    await setBody(p.id, p.cleaned);
    ok++;
    console.log(`[${i + 1}/${targets.length}] #${p.id}  débrandé  | ${(p.title || "").slice(0, 50)}`);
  } catch (e) {
    fail++;
    console.error(`[${i + 1}/${targets.length}] #${p.id} ÉCHEC : ${e.message}`);
  }
  await sleep(RL_MS);
}
console.log(`\nApply terminé. OK : ${ok}, échecs : ${fail}.`);
process.exit(fail ? 1 : 0);
