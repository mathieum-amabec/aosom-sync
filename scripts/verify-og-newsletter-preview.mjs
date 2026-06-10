// Read-only verification of the PREVIEW theme render.
import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";

// Asset present?
try {
  const a = await rest(`/themes/${PREVIEW}/assets.json?asset[key]=${encodeURIComponent("assets/og-image-social.jpg")}`);
  const j = await a.json();
  console.log("asset present:", !!j.asset, "| size:", j.asset?.size, "| content_type:", j.asset?.content_type);
} catch (e) { console.log("asset check err:", e.message); }

// index.json no longer has lc_newsletter?
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
console.log("lc_newsletter in sections:", !!idx.sections.lc_newsletter, "| in order:", idx.order.includes("lc_newsletter"));

// Rendered preview home: og:image tags + email inputs
const res = await fetch(`https://ameublodirect.ca/?preview_theme_id=${PREVIEW}`, { redirect: "follow" });
const html = await res.text();
console.log("\npreview fetch status:", res.status, "final url:", res.url);
const ogs = [...html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/gi)].map((m) => m[1]);
console.log("og:image tags rendered:", ogs.length);
ogs.forEach((u, i) => console.log(`  [${i}] ${u}`));
console.log("og-image-social.jpg referenced:", html.includes("og-image-social"));
const emailInputs = (html.match(/type=["']email["']/gi) || []).length;
console.log("email inputs on preview home:", emailInputs, "(was 2: home-body + footer; expect 1 if body removed)");
console.log("'Restez à l'affût' present:", html.includes("Restez"));
console.log("'Abonnez-vous gratuitement' (footer) present:", html.includes("Abonnez-vous"));
