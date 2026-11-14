#!/usr/bin/env node
/** Translate the two Search & Discovery filter labels that had no translation ("Couleur", "Taille"),
 * which showed French on furnishdirect.ca collections. Registers only missing locales.
 *   node-x64 --env-file=.env.local scripts/seo-audit-filter-labels-2026-10-31.mjs [--apply] */
import { gql, loadEnv } from "./_shopify-lib.mjs";
loadEnv();
const APPLY = process.argv.includes("--apply");
const MAP = { Couleur: { en: "Colour", es: "Color", pa: "ਰੰਗ" }, Taille: { en: "Size", es: "Tamaño", pa: "ਆਕਾਰ" } };
const d = (await gql(`{translatableResources(first:50,resourceType:FILTER){nodes{resourceId translatableContent{key value digest}
  en:translations(locale:"en"){key} es:translations(locale:"es"){key} pa:translations(locale:"pa"){key}}}}`)).data;
for (const n of d.translatableResources.nodes) {
  const c = n.translatableContent.find((x) => x.key === "label");
  const m = MAP[c?.value];
  if (!m) continue;
  const t = Object.entries(m).filter(([loc]) => !n[loc].some((x) => x.key === "label"))
    .map(([locale, value]) => ({ key: "label", locale, value, translatableContentDigest: c.digest }));
  console.log(c.value, "→", t.map((x) => `${x.locale}:${x.value}`).join(", ") || "(already translated)");
  if (!APPLY || !t.length) continue;
  const r = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: n.resourceId, t })).data;
  console.log("  errors:", JSON.stringify(r.translationsRegister.userErrors));
}
if (!APPLY) console.log("DRY-RUN");
