// B2 read-only: check Judge.me reviews + locate "Anonyme" testimonials in preview.
import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";
const SHOP = "ameublodirect.myshopify.com";

// 1. Judge.me public reviews API (try the literal token the task gave).
for (const token of ["PUBLIC"]) {
  try {
    const url = `https://judge.me/api/v1/reviews?api_token=${token}&shop_domain=${SHOP}&per_page=10&rating=5`;
    const r = await fetch(url);
    console.log(`Judge.me api_token=${token} -> status ${r.status}`);
    const txt = await r.text();
    console.log("  body:", txt.slice(0, 300));
  } catch (e) { console.log("Judge.me err:", e.message); }
}

// 1b. Storefront Judge.me badge/count (the preview_badge renders real totals).
try {
  const html = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`)).text();
  const m = html.match(/(\d+)\s*(reviews|avis|évaluations)/i);
  const jm = /judge\.?me/i.test(html);
  console.log(`\nstorefront: judge.me present=${jm} | review-count match=${m ? m[0] : "(none)"}`);
} catch (e) { console.log("storefront err:", e.message); }

// 2. Scan preview assets for "Anonyme"
const assets = (await (await rest(`/themes/${PREVIEW}/assets.json`)).json()).assets;
const textKeys = assets.map((a) => a.key).filter((k) => /\.(liquid|json|js)$/.test(k));
console.log(`\n=== scanning ${textKeys.length} preview assets for "Anonyme" ===`);
for (const key of textKeys) {
  let v;
  try { v = await getAsset(key, PREVIEW); } catch { continue; }
  if (!/anonyme/i.test(v)) continue;
  v.split(/\r?\n/).forEach((line, i) => {
    if (/anonyme/i.test(line)) console.log(`${key}:${i + 1}: ${line.trim().slice(0, 160)}`);
  });
}
