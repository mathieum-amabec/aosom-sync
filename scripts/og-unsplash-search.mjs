// Read-only: search Unsplash for an og:image candidate (patio/outdoor lifestyle).
import { loadEnv } from "./_shopify-lib.mjs";
const env = loadEnv();
const key = env.UNSPLASH_ACCESS_KEY;
if (!key) throw new Error("UNSPLASH_ACCESS_KEY missing in .env.local");

const url = "https://api.unsplash.com/search/photos?query=" +
  encodeURIComponent("patio furniture outdoor living summer") +
  "&orientation=landscape&per_page=10&content_filter=high";
const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
console.log("status", res.status);
const d = await res.json();
const rows = d.results || [];
console.log(`results: ${rows.length}\n`);
rows.forEach((p, i) => {
  console.log(`[${i}] ${p.id} | ${p.width}x${p.height} (r=${(p.width / p.height).toFixed(2)})`);
  console.log(`     desc: ${(p.description || p.alt_description || "").slice(0, 80)}`);
  console.log(`     by: ${p.user?.name} | likes=${p.likes}`);
  console.log(`     raw: ${p.urls?.raw}`);
  console.log(`     download_location: ${p.links?.download_location}`);
});
