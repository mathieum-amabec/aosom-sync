/**
 * One-time backfill: merges duplicate EN/FR "Couleur" option values (e.g. "Red" +
 * "Rouge") on already-created Shopify products into one correct French value. The
 * translation table below is a deliberate copy of EN_COLOR_TO_FR in
 * src/lib/variant-merger.ts (translateColor) — kept as a plain .mjs with no TS
 * import so this one-off script has no build/path-alias dependency; the "covers
 * every COLOR_MAP English equivalent" test in tests/variant-merger.test.ts is what
 * keeps the two from drifting apart. See fix/color-option-en-fr-duplicate.
 *
 * Root cause (see investigation, 2026-09-15): variant-merger.ts used to derive the
 * French color from a 2-letter SKU-suffix match against COLOR_MAP. A merged product's
 * PSIN "base" SKU (e.g. a 2-in-1 bundle's parent item) never carries that suffix, so it
 * kept the feed's raw English color while its siblings got translated — producing two
 * option values for the same color on the same product. Fixed at the source in
 * variant-merger.ts; this script cleans up the products already created before the fix.
 *
 * This script only RENAMES an existing variant's option1 text (Couleur). It never
 * changes a variant's id, sku, price or inventory, so it cannot affect any historical
 * order — Shopify snapshots the variant title into the order line item at purchase
 * time and never rewrites it retroactively.
 *
 * Usage (x64 Node, prod creds):
 *   node --env-file=.env.local scripts/backfill-color-option-duplicates.mjs             # dry run
 *   node --env-file=.env.local scripts/backfill-color-option-duplicates.mjs --apply     # write
 *   node --env-file=.env.local scripts/backfill-color-option-duplicates.mjs --ids 123,456 --apply
 */
const EN_COLOR_TO_FR = {
  black: "Noir",
  "dark grey": "Gris foncé",
  "dark gray": "Gris foncé",
  "dark brown": "Brun foncé",
  green: "Vert",
  "light grey": "Gris pâle",
  "light gray": "Gris pâle",
  "light green": "Vert pâle",
  silver: "Argent",
  cream: "Crème",
  charcoal: "Gris charbon",
  grey: "Gris",
  gray: "Gris",
  blue: "Bleu",
  brown: "Brun",
  beige: "Beige",
  "dark blue": "Bleu foncé",
  "forest green": "Vert forêt",
  khaki: "Kaki",
  walnut: "Noyer",
  white: "Blanc",
  red: "Rouge",
  pink: "Rose",
  orange: "Orange",
  natural: "Naturel",
  coffee: "Café",
};
function translateColor(rawColor) {
  const key = (rawColor || "").trim().toLowerCase();
  return EN_COLOR_TO_FR[key] || rawColor;
}

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
if (!TOKEN) { console.error("SHOPIFY_ACCESS_TOKEN required"); process.exit(1); }

const APPLY = process.argv.includes("--apply");
const idsIdx = process.argv.indexOf("--ids");
const ONLY_IDS = idsIdx !== -1 ? process.argv[idsIdx + 1].split(",") : null;

let lastReq = 0;
async function shopifyReq(url, opts = {}) {
  const wait = 560 - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(url, {
    ...opts,
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 4000)); return shopifyReq(url, opts); }
  return res;
}

async function fetchActiveProducts() {
  let url = `https://${STORE}/admin/api/${API}/products.json?limit=250&fields=id,title,handle,status,options,variants`;
  const out = [];
  while (url) {
    const res = await shopifyReq(url);
    const { link } = { link: res.headers.get("link") || "" };
    const json = await res.json();
    for (const p of json.products || []) {
      if (p.status === "active" && (!ONLY_IDS || ONLY_IDS.includes(String(p.id)))) out.push(p);
    }
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

function findColorOptionPosition(product) {
  const opt = (product.options || []).find((o) => /^couleur$/i.test(o.name));
  return opt ? opt.position : null;
}

function optionKey(pos) {
  return pos === 1 ? "option1" : pos === 2 ? "option2" : "option3";
}

const products = await fetchActiveProducts();
const plan = [];

for (const p of products) {
  const pos = findColorOptionPosition(p);
  if (!pos) continue;
  const key = optionKey(pos);
  const values = [...new Set((p.variants || []).map((v) => v[key]).filter(Boolean))];
  if (values.length < 2) continue;

  // A duplicate is a pair of distinct raw strings that translateColor() collapses
  // to the SAME French value.
  const byCanonical = new Map();
  for (const v of values) {
    const fr = translateColor(v);
    if (!byCanonical.has(fr)) byCanonical.set(fr, []);
    byCanonical.get(fr).push(v);
  }

  for (const [fr, raws] of byCanonical) {
    if (raws.length < 2) continue;
    // Variant(s) whose current value is not already the canonical FR spelling need fixing.
    const toFix = raws.filter((r) => r !== fr);
    for (const rawValue of toFix) {
      const variant = p.variants.find((v) => v[key] === rawValue);
      // Collision check: would the corrected value clash with another variant's full option set?
      const otherVariants = p.variants.filter((v) => v.id !== variant.id);
      const wouldCollide = otherVariants.some((v) => {
        const sig1 = pos === 1 ? fr : variant.option1;
        const sig2 = pos === 2 ? fr : variant.option2;
        const sig3 = pos === 3 ? fr : variant.option3;
        return v.option1 === sig1 && v.option2 === sig2 && v.option3 === sig3;
      });
      plan.push({
        productId: p.id,
        handle: p.handle,
        title: p.title,
        variantId: variant.id,
        sku: variant.sku,
        optionKey: key,
        from: rawValue,
        to: fr,
        collision: wouldCollide,
      });
    }
  }
}

console.log(`\n=============== COLOR OPTION BACKFILL (${APPLY ? "APPLY" : "DRY RUN"}) ===============`);
console.log(`Active products scanned: ${products.length}`);
console.log(`Variants to fix: ${plan.length}\n`);
for (const item of plan) {
  const flag = item.collision ? "  ⚠ COLLISION — SKIPPED" : "";
  console.log(`  ${item.productId} ${item.handle}  [${item.sku}] "${item.from}" → "${item.to}"${flag}`);
}

const safe = plan.filter((p) => !p.collision);
const skipped = plan.filter((p) => p.collision);
console.log(`\nSafe to apply: ${safe.length}. Skipped (collision, needs manual review): ${skipped.length}.`);

if (APPLY) {
  console.log("\nApplying...");
  for (const item of safe) {
    const res = await shopifyReq(`https://${STORE}/admin/api/${API}/variants/${item.variantId}.json`, {
      method: "PUT",
      body: JSON.stringify({ variant: { id: item.variantId, [item.optionKey]: item.to } }),
    });
    if (!res.ok) {
      console.error(`  FAILED ${item.productId} [${item.sku}]: ${res.status} ${await res.text()}`);
      continue;
    }
    console.log(`  OK ${item.productId} [${item.sku}] ${item.optionKey} → "${item.to}"`);
  }
  console.log("Done.");
} else {
  console.log("\nDry run only — pass --apply to write these changes to Shopify.");
}
