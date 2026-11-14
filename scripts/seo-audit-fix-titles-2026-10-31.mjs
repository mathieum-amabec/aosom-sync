#!/usr/bin/env node
/**
 * Titles that contradict the product's own variant / description, found by the 2026-10-31 meta
 * review agents. Handles are kept. When the FR title changes, the EN title is re-registered against
 * the new digest (else Shopify marks it outdated); custom.title_en is kept in step.
 *   node-x64 --env-file=.env.local scripts/seo-audit-fix-titles-2026-10-31.mjs [--apply]
 */
import fs from "node:fs";
import { gql, loadEnv } from "./_shopify-lib.mjs";
loadEnv();
const APPLY = process.argv.includes("--apply");
const FIXES = [
  // Variant is 62.6" x 41.7" (159 x 106 cm): "5,2 x 3,5" was feet, not metres.
  { handle: "remise-rangement-exterieur-5-2-x-3-5", title: "Remise de rangement extérieur 159 x 106 cm — Gris foncé", titleEn: "Outdoor Storage Shed 159 x 106 cm (5.2 x 3.5 ft) — Dark Grey" },
  // 1 table + 4 chairs per the description and the EN title.
  { handle: "ensemble-salle-a-manger-3-pieces-verre-trempe-cadre-metal-brun-clair", title: "Ensemble salle à manger 5 pièces, verre trempé et cadre en métal — Brun clair", titleEn: null },
  // Sold in two sizes (variants 10' x 10' and 10' x 12').
  { handle: "moustiquaire-remplacement-gazebo-3x36m-1", title: "Moustiquaire de remplacement pour gazebo 3 x 3 m ou 3 x 3,6 m", titleEn: "Replacement Mosquito Netting for Gazebo 10 x 10 ft or 10 x 12 ft" },
  // Garbled custom.title_en metafield ("set of 5 cm linen"); the EN translation was already right.
  { handle: "chaise-salle-a-manger-lot-de-2-lin", title: null, titleEn: "Linen Dining Chairs — Set of 2" },
];
const out = ".context/seo-audit/backup-titles-2026-10-31.json";
const backup = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
for (const f of FIXES) {
  const p = (await gql(`query($h:String!){productByHandle(handle:$h){id title mf:metafield(namespace:"custom",key:"title_en"){value} translations(locale:"en"){key value}}}`, { h: f.handle })).data.productByHandle;
  const enNow = p.translations.find((t) => t.key === "title")?.value ?? p.mf?.value ?? "";
  backup[f.handle] ??= { title: p.title, title_en_mf: p.mf?.value ?? null, title_en_tr: enNow };
  const en = f.titleEn ?? enNow;
  console.log(`${f.handle}\n  FR: ${p.title} → ${f.title ?? "(unchanged)"}\n  EN: ${enNow} → ${en}`);
  if (!APPLY) continue;
  fs.writeFileSync(out, JSON.stringify(backup, null, 1));
  const input = { id: p.id, metafields: [{ namespace: "custom", key: "title_en", type: "single_line_text_field", value: en }] };
  if (f.title) input.title = f.title;
  const u = (await gql(`mutation($p:ProductInput!){productUpdate(input:$p){userErrors{field message}}}`, { p: input })).data.productUpdate;
  if (u.userErrors.length) throw new Error(JSON.stringify(u.userErrors));
  const dig = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: p.id })).data.translatableResource.translatableContent.find((c) => c.key === "title").digest;
  const r = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: p.id, t: [{ key: "title", locale: "en", value: en, translatableContentDigest: dig }] })).data.translationsRegister;
  if (r.userErrors.length) throw new Error(JSON.stringify(r.userErrors));
  console.log("  ✔ applied");
}
if (!APPLY) console.log("DRY-RUN");

// SEO titles (<title>) repeated the same errors. seo.description is re-sent so it is never wiped.
const SEO = [
  { handle: "remise-rangement-exterieur-5-2-x-3-5", fr: "Remise de rangement extérieur 159 x 106 cm | Ameublo Direct", en: "Outdoor Storage Shed 159 x 106 cm | Furnish Direct" },
  { handle: "ensemble-salle-a-manger-3-pieces-verre-trempe-cadre-metal-brun-clair", fr: "Ensemble salle à manger 5 pièces verre trempé | Ameublo Direct", en: null },
  { handle: "moustiquaire-remplacement-gazebo-3x36m-1", fr: null, en: "Gazebo Mosquito Netting 10x10 or 10x12 ft | Furnish Direct" },
];
for (const s of SEO) {
  const p = (await gql(`query($h:String!){productByHandle(handle:$h){id seo{title description} translations(locale:"en"){key value}}}`, { h: s.handle })).data.productByHandle;
  const enNow = p.translations.find((t) => t.key === "meta_title")?.value;
  console.log(`${s.handle}\n  seoFR: ${p.seo.title} → ${s.fr ?? "(unchanged)"}\n  seoEN: ${enNow} → ${s.en ?? "(re-registered)"}`);
  if (!APPLY) continue;
  if (s.fr) {
    const u = (await gql(`mutation($p:ProductInput!){productUpdate(input:$p){userErrors{field message}}}`, { p: { id: p.id, seo: { title: s.fr, description: p.seo.description } } })).data.productUpdate;
    if (u.userErrors.length) throw new Error(JSON.stringify(u.userErrors));
  }
  const dig = (await gql(`query($id:ID!){translatableResource(resourceId:$id){translatableContent{key digest}}}`, { id: p.id })).data.translatableResource.translatableContent.find((c) => c.key === "meta_title").digest;
  const r = (await gql(`mutation($id:ID!,$t:[TranslationInput!]!){translationsRegister(resourceId:$id,translations:$t){userErrors{field message}}}`, { id: p.id, t: [{ key: "meta_title", locale: "en", value: s.en ?? enNow, translatableContentDigest: dig }] })).data.translationsRegister;
  if (r.userErrors.length) throw new Error(JSON.stringify(r.userErrors));
  console.log("  ✔ seo applied");
}
