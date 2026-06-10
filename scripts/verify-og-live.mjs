import { getAsset } from "./_shopify-lib.mjs";
const LIVE = "160059195497";

const s = await getAsset("snippets/meta-tags.liquid", LIVE);
console.log("meta-tags has index branch:", s.includes("request.page_type == 'index'"));
console.log("meta-tags references og-image-social:", s.includes("og-image-social.jpg"));

let assetOk = "present";
try { await getAsset("assets/og-image-social.jpg", LIVE); } catch (e) { assetOk = "ERR " + e.message; }
console.log("live asset og-image-social.jpg:", assetOk);

const ar = await fetch("https://ameublodirect.ca/cdn/shop/t/6/assets/og-image-social.jpg", { method: "HEAD" });
console.log("asset CDN HEAD:", ar.status, ar.headers.get("content-type"));

for (let i = 0; i < 3; i++) {
  const q = "cb" + Date.now() + i;
  const r = await fetch("https://ameublodirect.ca/?" + q, { cache: "no-store" });
  const h = await r.text();
  const og = (h.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [])[1] || "(none)";
  console.log(`home ?${q} -> bytes ${h.length} | has og-image-social: ${h.includes("og-image-social")} | og:image=${og.slice(0, 60)}`);
  await new Promise((r) => setTimeout(r, 1500));
}
