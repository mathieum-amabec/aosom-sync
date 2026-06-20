// Set shop-level SEO metafields (description_tag, og_image) and verify the
// rendered home <head>. Shop metafields are easily reversible (DELETE).
import { rest, LIVE_THEME_ID } from "./_shopify-lib.mjs";

const META_DESC = "Aménagez votre patio et votre jardin pour l'été québécois : mobilier d'extérieur, BBQ, déco et accessoires, livrés gratuitement partout au Canada.";

// Preview theme asset CDN url (already uploaded). We try to resolve it for the og_image value.
const PREVIEW = "160213696617";
if (PREVIEW === LIVE_THEME_ID) throw new Error("refusing to run against the LIVE theme");
let ogUrl = "";
try {
  const a = await (await rest(`/themes/${PREVIEW}/assets.json?asset[key]=${encodeURIComponent("assets/og-image-social.jpg")}`)).json();
  ogUrl = a.asset?.public_url || "";
  console.log("preview asset public_url:", ogUrl || "(not returned by API)");
} catch (e) { console.log("asset lookup err:", e.message); }

// Current shop global metafields
const before = await (await rest("/metafields.json?namespace=global")).json();
console.log("existing global shop metafields:", (before.metafields || []).map((m) => `${m.namespace}.${m.key}=${String(m.value).slice(0,30)}`).join(" | ") || "(none)");

async function setMeta(key, value) {
  const res = await rest("/metafields.json", {
    method: "POST",
    body: JSON.stringify({ metafield: { namespace: "global", key, value, type: "single_line_text_field" } }),
  });
  const j = await res.json();
  console.log(`POST global.${key}: ${res.status} ${res.ok ? "OK id=" + j.metafield?.id : JSON.stringify(j.errors)}`);
}

await setMeta("description_tag", META_DESC);
if (ogUrl) await setMeta("og_image", ogUrl);
else console.log("skip og_image metafield: no public_url resolved");

// Re-read to confirm persisted
const after = await (await rest("/metafields.json?namespace=global")).json();
console.log("\nglobal shop metafields now:");
for (const m of after.metafields || []) console.log(`  ${m.namespace}.${m.key} [${m.type}] = ${String(m.value).slice(0,60)}`);

// Verify rendered home head (cache may lag)
const html = await (await fetch("https://ameublodirect.ca/", { cache: "no-store" })).text();
const head = html.slice(0, html.indexOf("</head>") + 7);
const grab = (re) => { const m = head.match(re); return m ? m[1] : "(none)"; };
console.log("\n=== rendered home <head> after ===");
console.log("description:", grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i));
console.log("og:image   :", grab(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i));
