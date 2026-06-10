// Read-only feasibility probe for chantiers 2/3/4.
import { rest, getAsset } from "./_shopify-lib.mjs";
const THEME = "160059195497";

// --- Home page rendered <head>: og:image + meta description ---
const res = await fetch("https://ameublodirect.ca/");
const html = await res.text();
const head = html.slice(0, html.indexOf("</head>") + 7);
const grab = (re) => { const m = head.match(re); return m ? m[1] : "(none)"; };
console.log("=== HOME <head> SEO ===");
console.log("og:image      :", grab(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i));
console.log("og:image:width:", grab(/<meta[^>]+property=["']og:image:width["'][^>]+content=["']([^"']+)["']/i));
console.log("twitter:image :", grab(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i));
console.log("description   :", grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i));
console.log("og:title      :", grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i));

// --- Theme settings_data.json: social/share image setting? ---
try {
  const sd = JSON.parse(await getAsset("config/settings_data.json", THEME));
  const cur = sd.current || {};
  const keys = Object.keys(cur).filter((k) => /share|social|seo|og|image/i.test(k));
  console.log("\n=== settings_data.json social/share keys ===");
  console.log(keys.length ? keys.map((k) => `${k} = ${JSON.stringify(cur[k])}`).join("\n") : "(no share/social image setting)");
} catch (e) { console.log("settings_data error:", e.message); }

// --- og:image in theme.liquid? (how the head renders it) ---
const layout = await getAsset("layout/theme.liquid", THEME);
const ogLines = layout.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /og:image|share_image|page_image|meta name="description"|metafield.*description|og:description/i.test(l));
console.log("\n=== layout/theme.liquid head SEO lines ===");
console.log(ogLines.length ? ogLines.map(([n, l]) => `${n}: ${l.trim().slice(0, 120)}`).join("\n") : "(no inline og:image/description in theme.liquid — likely rendered by a snippet or Shopify default)");

// --- Newsletter blocks in home index.json ---
const idx = JSON.parse(await getAsset("templates/index.json", THEME));
console.log("\n=== Newsletter-related home sections ===");
for (const [id, sec] of Object.entries(idx.sections)) {
  const blob = JSON.stringify(sec).toLowerCase();
  if (/newsletter|klaviyo|infolettre|email_form|s'inscrire|inscription|courriel/i.test(blob)) {
    console.log(`- ${id} [${sec.type}] in order=${idx.order.includes(id)}`);
    if (sec.type === "custom-liquid") {
      const cl = sec.settings?.custom_liquid || "";
      console.log(`    custom_liquid head: ${cl.replace(/\s+/g, " ").slice(0, 160)}`);
      console.log(`    klaviyo? ${/klaviyo/i.test(cl)}  email input? ${/type=["']email["']/i.test(cl)}`);
    } else {
      console.log(`    settings: ${JSON.stringify(sec.settings).slice(0, 160)}`);
    }
  }
}
console.log("\nHOME ORDER:", idx.order.join(", "));
