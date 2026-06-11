// Read-only: Unsplash search per category + real collection titles.
import { loadEnv, rest } from "./_shopify-lib.mjs";
const key = loadEnv().UNSPLASH_ACCESS_KEY;
if (!key) throw new Error("UNSPLASH_ACCESS_KEY missing");

const cats = [
  { handle: "meubles-et-decorations", q: "modern living room furniture" },
  { handle: "mobiliers-exterieurs-et-jardins", q: "outdoor patio furniture summer" },
  { handle: "chaises-et-tables-de-patio-1", q: "patio dining set outdoor" },
  { handle: "jardinage-et-serres", q: "garden backyard landscaping" },
  { handle: "accessoires-pour-animaux", q: "pet dog cat home" },
  { handle: "sports-et-loisirs", q: "camping outdoor recreation backyard" },
];

// Collection titles by handle
const smart = (await (await rest("/smart_collections.json?limit=250")).json()).smart_collections || [];
const custom = (await (await rest("/custom_collections.json?limit=250")).json()).custom_collections || [];
const titleOf = (h) => (smart.find((c) => c.handle === h) || custom.find((c) => c.handle === h) || {}).title || "(NOT FOUND)";

for (const c of cats) {
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(c.q)}&orientation=landscape&per_page=5&content_filter=high`;
  const r = await fetch(url, { headers: { Authorization: `Client-ID ${key}` } });
  const d = await r.json();
  const top = (d.results || [])[0];
  console.log(`\n[${c.handle}] title="${titleOf(c.handle)}"  q="${c.q}"  status=${r.status}`);
  if (top) {
    console.log(`  photo=${top.id} ${top.width}x${top.height} by ${top.user?.name} | ${(top.description || top.alt_description || "").slice(0, 60)}`);
    console.log(`  raw=${top.urls.raw}`);
    console.log(`  dl=${top.links.download_location}`);
  } else console.log("  (no result)");
}
