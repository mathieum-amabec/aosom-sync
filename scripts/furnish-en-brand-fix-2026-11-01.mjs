#!/usr/bin/env node
/**
 * Furnish Direct conversion audit (2026-11-01), content part — no theme involved:
 *  - EN translations for the 3 shop policies that were French-only on furnishdirect.ca (contact, legal notice,
 *    terms of service), all linked from the checkout.
 *  - EN shipping policy: Ontario first instead of "1. DELIVERY IN QUEBEC".
 *  - EN pages: Furnish Direct instead of Ameublo Direct where it is the brand, plus one transparency line
 *    (Furnish Direct = the English-language store of Ameublo Direct, the name shown at checkout) — the checkout
 *    can only show the single shop name, so we explain it instead of hiding it.
 * The email info@ameublodirect.ca is kept: no furnishdirect.ca mailbox exists yet.
 * Only EN translations are written; the French content is untouched.
 *   node-x64 --env-file=.env.local scripts/furnish-en-brand-fix-2026-11-01.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const SAME_CO = "Furnish Direct is the English-language store of Ameublo Direct";

const POLICIES = {
  // CONTACT_INFORMATION
  "gid://shopify/ShopPolicy/39868170345": `<p>Furnish Direct — the English-language store of Ameublo Direct<br>Customer service Monday to Friday, 9 a.m. to 5 p.m. (ET)</p>
<p>Email: info@ameublodirect.ca<br>Response time: 1 to 2 business days</p>
<p>For returns and claims, always include your order number and photos where applicable.</p><p>Phone: 514-292-7788</p>`,
  // LEGAL_NOTICE
  "gid://shopify/ShopPolicy/39868203113": `<p>${SAME_CO}, an e-commerce business operating in Canada. Because both stores are run by the same company, the name Ameublo Direct appears at checkout and in your order emails.</p>
<p>Publisher: Ameublo Direct<br>Hosting: Shopify Inc., 150 Elgin Street, Ottawa, Ontario</p>
<p>Products are sold under our house brand, Ameublo Direct / Furnish Direct. Manufacturer names are not displayed, in line with our business policy.</p>
<p>In accordance with Quebec's Consumer Protection Act and Canada's Anti-Spam Legislation (CASL), we are committed to protecting your personal information. See our privacy policy for details.</p>`,
  // TERMS_OF_SERVICE
  "gid://shopify/ShopPolicy/39868104809": `<p>By accessing furnishdirect.ca or ameublodirect.ca, you agree to these terms of use. ${SAME_CO}; both sites are operated by Ameublo Direct.</p>
<p>ORDERS AND PAYMENT<br>All orders are subject to availability. We reserve the right to cancel any order in the event of a stock shortage or a pricing error. Full payment is required when the order is placed.</p>
<p>DELIVERY<br>Delivery times are estimates and are not guaranteed. We cannot be held responsible for delays caused by the carrier. Orders usually ship within 1 to 3 business days, then arrive within 3 to 9 business days depending on the region (see our shipping policy).</p>
<p>LIMITATION OF LIABILITY<br>We are not liable for indirect, incidental or consequential damages arising from the use of our products. Our liability is limited to the amount of the order concerned.</p>
<p>INTELLECTUAL PROPERTY<br>All content on this site (text, images, logos) is the property of Ameublo Direct and may not be reproduced without written permission.</p>
<p>GOVERNING LAW<br>These terms are governed by the laws of the Province of Quebec and of Canada.</p>
<p>Contact: info@ameublodirect.ca</p>`,
};

// Edits applied to the CURRENT EN translation (exact substrings; each must be found).
const EDITS = {
  // SHIPPING_POLICY: Ontario first; same delays as before, nothing promised that the French policy doesn't say.
  "gid://shopify/ShopPolicy/39868137577": [[
    /<p><strong>1\. DELIVERY IN QUEBEC<\/strong>[\s\S]*?<\/p>\s*<p><strong>2\. ONTARIO AND THE MARITIMES<\/strong><br>Delivery time: 3 to 5 business days after shipment<\/p>/,
    `<p>Furnish Direct is the English-language store of Ameublo Direct, a Quebec-based Canadian company. Customer service: Monday to Friday, Eastern Time.</p>
<p><strong>1. ONTARIO, QUEBEC AND THE MARITIMES</strong><br>Delivery time: 3 to 5 business days after shipment</p>`,
  ], ["<strong>3. REST OF CANADA</strong>", "<strong>2. REST OF CANADA</strong>"], ["<strong>4. REGIONS NOT SERVED</strong>", "<strong>3. REGIONS NOT SERVED</strong>"]],
  // a-propos
  "gid://shopify/Page/119862001769": [
    ["<h2>Ameublo Direct — Your furniture partner in Canada</h2>", "<h2>Furnish Direct — Your furniture partner in Canada</h2>"],
    ["<p>Ameublo Direct is a <strong>Canadian</strong> company born from a simple belief", "<p>Furnish Direct is the English-language store of Ameublo Direct, a <strong>Canadian</strong> company born from a simple belief"],
    ["shipped free across Canada.</p>", "shipped free across Canada. Same company, same team — which is why you will see the name Ameublo Direct at checkout and in your order emails.</p>"],
  ],
  // conditions-dutilisation
  "gid://shopify/Page/119862198377": [["Thank you for visiting&nbsp;<strong>ameublodirect.ca</strong>.", "Thank you for visiting&nbsp;<strong>furnishdirect.ca</strong>."]],
  // financement
  "gid://shopify/Page/158727897193": [
    ["</strong> Ameublo Direct does not lend money", "</strong> Furnish Direct does not lend money"],
    ["Ameublo Direct does not act as a lender", "Furnish Direct does not act as a lender"],
  ],
  // questions-et-reponses (HTML + FAQPage JSON-LD: 2 occurrences)
  "gid://shopify/Page/120033542249": [[/Yes\. Furnish Direct \(Ameublo Direct\) is a Canadian company\./g,
    "Yes. Furnish Direct is the English-language store of Ameublo Direct, a Canadian company — which is why the name Ameublo Direct appears at checkout."]],
};

const BRAND_RE = /\b(aosom|outsunny|homcom|pawhut|soozier|qaba|vinsetto|costway)\b/i;
const plan = [];
for (const id of [...Object.keys(POLICIES), ...Object.keys(EDITS)]) {
  const r = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key value digest} translations(locale:"en"){key value}}}`, { id })).data.translatableResource;
  const key = r.translatableContent.find((t) => t.key === "body" || t.key === "body_html").key;
  const digest = r.translatableContent.find((t) => t.key === key).digest;
  let value;
  if (POLICIES[id]) value = POLICIES[id];
  else {
    value = r.translations.find((t) => t.key === key)?.value;
    if (!value) throw new Error(`${id}: no EN translation to edit`);
    for (const [from, to] of EDITS[id]) {
      const hit = typeof from === "string" ? value.includes(from) : from.test(value);
      if (!hit) throw new Error(`${id}: edit not found: ${String(from).slice(0, 80)}`);
      if (from instanceof RegExp) from.lastIndex = 0;
      value = typeof from === "string" ? value.split(from).join(to) : value.replace(from, to);
    }
  }
  if (BRAND_RE.test(value)) throw new Error(`${id}: supplier name in text`);
  const before = r.translations.find((t) => t.key === key)?.value || "";
  plan.push({ id, key, digest, before, value });
  console.log(`${id.split("/").slice(-2).join("/")} ${key}: ${before ? "update" : "NEW"} · Ameublo mentions ${(before.match(/ameublo/gi) || []).length} → ${(value.match(/ameublo/gi) || []).length}`);
}
fs.mkdirSync(".context/furnish-fix", { recursive: true });
fs.writeFileSync(".context/furnish-fix/en-plan.json", JSON.stringify(plan, null, 1));
if (APPLY) fs.writeFileSync(`.context/furnish-fix/en-plan.applied-${Date.now()}.json`, JSON.stringify(plan, null, 1)); // rollback source (before = previous EN; empty = translationsRemove)
if (!APPLY) { console.log("DRY-RUN — plan in .context/furnish-fix/en-plan.json, nothing written."); process.exit(0); }

let errors = 0;
for (const p of plan) {
  const e = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`,
    { id: p.id, t: [{ key: p.key, locale: "en", value: p.value, translatableContentDigest: p.digest }] })).data.translationsRegister.userErrors;
  if (e.length) { errors++; console.log("✘", p.id, JSON.stringify(e)); continue; }
  const back = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translations(locale:"en"){key value}}}`, { id: p.id })).data.translatableResource.translations.find((t) => t.key === p.key)?.value;
  console.log(back === p.value ? "✔" : "✘ read-back differs", p.id);
  if (back !== p.value) errors++;
}
console.log(`APPLIED — ${errors} error(s)`);
