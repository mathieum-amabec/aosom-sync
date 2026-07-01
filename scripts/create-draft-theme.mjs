// Create a new unpublished copy of the current live theme (160606093417) to serve as
// the next working DRAFT. Shopify copies asynchronously; returns the new id immediately.
// Loads SHOPIFY_ACCESS_TOKEN from .env.local. Pass --apply to actually create.
import { readFileSync } from "node:fs";

function loadEnv() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv();
const STORE = "27u5y2-kp.myshopify.com";
const API = "2024-01";
const H = { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" };
const APPLY = process.argv.includes("--apply");

if (!APPLY) { console.log("--- DRY RUN --- (pass --apply to create the theme copy)"); process.exit(0); }

const res = await fetch(`https://${STORE}/admin/api/${API}/themes.json`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    theme: {
      // Shopify caps theme name at 50 chars; requested "...Copie de Trade v2" (53) trimmed to 50.
      name: "Copie de Copie de Copie de Copie de Copie Trade v2",
      source_theme_id: 160606093417,
      role: "unpublished",
    },
  }),
});
const body = await res.json();
console.log(`POST status: ${res.status}`);
console.log("NEW DRAFT:", JSON.stringify({ id: body.theme?.id, name: body.theme?.name, role: body.theme?.role, processing: body.theme?.processing }));
