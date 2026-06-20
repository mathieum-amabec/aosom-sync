// Applies the og:image + newsletter-dedup edits to the PREVIEW theme ONLY.
// HARD GUARD: refuses to run against the live theme.
import { loadEnv, rest, getAsset, putAsset, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const LIVE = LIVE_THEME_ID;
const PREVIEW = "160213696617"; // "Copie de Copie de Trade v2" (unpublished)
if (PREVIEW === LIVE) throw new Error("ABORT: preview id equals live id");

// Verify the target is actually unpublished before any write.
const themes = (await (await rest("/themes.json")).json()).themes;
const t = themes.find((x) => String(x.id) === PREVIEW);
if (!t) throw new Error(`ABORT: theme ${PREVIEW} not found`);
if (t.role !== "unpublished") throw new Error(`ABORT: theme ${PREVIEW} role is '${t.role}', expected unpublished`);
console.log(`Target preview theme OK: ${t.id} "${t.name}" [${t.role}]`);

const env = loadEnv();

// --- 1. Unsplash: trigger download ping (API ToS) + build a 1200x630 crop URL ---
const PHOTO_ID = "UQXMWJHusQs";
const RAW = "https://images.unsplash.com/photo-1777052854737-7893f50de539?ixid=M3w5NTQ4MDN8MHwxfHNlYXJjaHw0fHxwYXRpbyUyMGZ1cm5pdHVyZSUyMG91dGRvb3IlMjBsaXZpbmclMjBzdW1tZXJ8ZW58MXwwfHx8MTc4MTEwNDc4Nnww&ixlib=rb-4.1.0";
try {
  const dl = await fetch(`https://api.unsplash.com/photos/${PHOTO_ID}/download`, {
    headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
  });
  console.log("Unsplash download ping:", dl.status);
} catch (e) { console.log("download ping failed (non-fatal):", e.message); }
const CROP_URL = `${RAW}&w=1200&h=630&fit=crop&crop=entropy&q=82&fm=jpg`;
console.log("crop url:", CROP_URL);

// --- 2. Upload as a PREVIEW theme asset via src ---
const aRes = await rest(`/themes/${PREVIEW}/assets.json`, {
  method: "PUT",
  body: JSON.stringify({ asset: { key: "assets/og-image-social.jpg", src: CROP_URL } }),
});
console.log("asset PUT status:", aRes.status, aRes.ok ? "OK" : await aRes.text());

// --- 3. Inject og:image into PREVIEW layout/theme.liquid (before </head>) ---
let layout = await getAsset("layout/theme.liquid", PREVIEW);
const META = `  <meta property="og:image" content="{{ 'og-image-social.jpg' | asset_url }}">`;
if (layout.includes("og-image-social.jpg")) {
  console.log("theme.liquid already has og-image-social.jpg — skipping inject");
} else {
  const idx = layout.indexOf("</head>");
  if (idx < 0) throw new Error("ABORT: </head> not found in theme.liquid");
  layout = layout.slice(0, idx) + META + "\n" + layout.slice(idx);
  await putAsset("layout/theme.liquid", layout, PREVIEW);
  console.log("theme.liquid PUT: 200 OK (og:image injected before </head>)");
}

// --- 4. Remove lc_newsletter from PREVIEW templates/index.json ---
const idxJson = JSON.parse(await getAsset("templates/index.json", PREVIEW));
const hadSection = !!idxJson.sections?.lc_newsletter;
const hadOrder = Array.isArray(idxJson.order) && idxJson.order.includes("lc_newsletter");
if (!hadSection && !hadOrder) {
  console.log("lc_newsletter already absent from index.json — skipping");
} else {
  delete idxJson.sections.lc_newsletter;
  idxJson.order = idxJson.order.filter((k) => k !== "lc_newsletter");
  await putAsset("templates/index.json", JSON.stringify(idxJson, null, 2), PREVIEW);
  console.log(`index.json PUT: 200 OK (removed lc_newsletter; section=${hadSection}, order=${hadOrder})`);
  console.log("new order:", idxJson.order.join(", "));
  console.log("footer newsletter (newsletter_DPwWK7) untouched in footer-group.json");
}

console.log("\nDONE. Preview theme id:", PREVIEW, "(live", LIVE, "untouched)");
