// Publish draft theme 160606093417 -> role:main (LIVE) via Shopify Admin API 2024-01.
// Loads SHOPIFY_ACCESS_TOKEN from .env.local (repo's admin token; NOT $SHOPIFY_ADMIN_TOKEN).
// Prints the PUT result then the roles of ALL themes. Pass --apply to actually publish.
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
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;
const DRAFT = "160606093417";
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };

async function listThemes(label) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/themes.json`, { headers: H });
  const themes = (await res.json()).themes;
  console.log(`\n--- theme roles (${label}) ---`);
  for (const t of themes.sort((a, b) => (a.role === "main" ? -1 : 1))) {
    console.log(`${t.id}\t[${t.role}]\t${t.name}`);
  }
  return themes;
}

console.log(APPLY ? "*** APPLY — publishing draft to LIVE ***" : "--- DRY RUN (no publish) ---");
const before = await listThemes("BEFORE");
const liveBefore = before.find((t) => t.role === "main");
console.log(`\nCurrent LIVE (main): ${liveBefore?.id} "${liveBefore?.name}"`);
console.log(`Will publish DRAFT: ${DRAFT} "${before.find((t) => String(t.id) === DRAFT)?.name}"`);

if (APPLY) {
  const res = await fetch(`https://${STORE}/admin/api/${API}/themes/${DRAFT}.json`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ theme: { id: Number(DRAFT), role: "main" } }),
  });
  const body = await res.json();
  console.log(`\nPUT status: ${res.status}`);
  console.log("PUT result:", JSON.stringify({ id: body.theme?.id, name: body.theme?.name, role: body.theme?.role }));
  await listThemes("AFTER");
} else {
  console.log("\n(dry run — pass --apply to publish)");
}
